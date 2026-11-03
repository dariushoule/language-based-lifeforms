"""The fish mind: turns what a fish perceives into a decision, and invents each newcomer's personality,
using an LLM (DS4 on the Sparks).

Connects to the sim's /mind websocket as a trusted client. It answers `decide` requests with a
`plan` (thought, feeling, optional speech, teachings and stances, actions) and `birth` requests with
a `born` persona inspired by a random Wikipedia article. The sim owns the world: it executes plans step by
step, re-validates everything, and falls back to instinct when the mind is slow, wrong or gone.

Config (repo-root .env or environment):
  BRAIN_URL, BRAIN_KEY, BRAIN_MODEL   OpenAI-compatible endpoint (vLLM serving DS4, for instance)
  BRAIN_CF_ID, BRAIN_CF_SECRET        optional Cloudflare Access headers (for the public endpoint)
  BRAIN_THINKING=1                    reason before answering (slower turns; off by default so talk flows)
  BRAIN_THINK_BUDGET                  reasoning tokens per decision when thinking, default 800
  MIND_TOKEN                          shared secret the sim expects on /mind
  SIM_URL                             default ws://localhost:8080/mind
  MIND_CONCURRENCY                    parallel requests, default 6
"""

import asyncio
import contextlib
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Annotated, Literal

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from openai import AsyncOpenAI
from pydantic import BaseModel, Field, field_validator
from pydantic_ai import Agent, AgentRunResult, AgentRunResultEvent, ModelSettings, ToolOutput
from pydantic_ai.messages import PartDeltaEvent, PartStartEvent, ThinkingPart, ThinkingPartDelta
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.profiles.openai import OpenAIModelProfile
from pydantic_ai.providers.openai import OpenAIProvider
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

log = logging.getLogger("mind")


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not line.lstrip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


load_env(Path(__file__).resolve().parent.parent / ".env")

# Conversation is the point of the aquarium, and a turn that takes minutes kills it, so the mind
# answers directly by default (10-20 seconds a turn). Thinking is still there for richer, slower fish.
THINKING = os.environ.get("BRAIN_THINKING", "0") != "0"
THINK_BUDGET = int(os.environ.get("BRAIN_THINK_BUDGET", "800"))
TIMEOUT = 140 if THINKING else 120  # s; the sim gives up on a decision after 150 (personas take up to ~80s)
STREAM_EVERY = 0.5                  # s between batches of reasoning streamed to the sim

# ---------- decisions ----------


class SwimTo(BaseModel):
    """Swim to a point in the tank."""

    type: Literal["swim_to"]
    x: int = Field(ge=20, le=1260)
    y: int = Field(ge=48, le=660)


class Eat(BaseModel):
    """Swim to a plant (or a fish's remains) and eat from it."""

    type: Literal["eat"]
    food_id: int
    amount: int = Field(1, ge=1, le=4, description="how many bites")


class Approach(BaseModel):
    """Swim up close to another fish, near enough to talk."""

    type: Literal["approach"]
    fish_id: int


class Follow(BaseModel):
    """Swim along behind another fish for a while."""

    type: Literal["follow"]
    fish_id: int
    seconds: int = Field(12, ge=3, le=40)


class Attack(BaseModel):
    """Chase another fish and bite it, up to three times."""

    type: Literal["attack"]
    fish_id: int


class Flee(BaseModel):
    """Swim away from another fish as fast as you can."""

    type: Literal["flee"]
    fish_id: int
    seconds: int = Field(6, ge=2, le=20)


class Rest(BaseModel):
    """Sink near the sand and rest to recover energy."""

    type: Literal["rest"]
    seconds: int = Field(15, ge=3, le=60)


class Wander(BaseModel):
    """Drift around with no particular aim."""

    type: Literal["wander"]
    seconds: int = Field(12, ge=3, le=40)


SandColor = Literal["bone", "ochre", "gold", "coral", "rust", "rose", "violet", "indigo", "sky", "teal", "jade", "charcoal"]


class MakeMandala(BaseModel):
    """Fetch a grain of colored sand from the floor and lay it in the mandala; it appears mirrored in all four quadrants."""

    type: Literal["make_mandala"]
    color: SandColor
    ring: int = Field(ge=0, le=11, description="0 is the center; larger rings are further out")
    slot: int = Field(ge=0, description="which slot of that ring, from 0 (ring r has 2r slots; ring 0 has 1)")


class DropUrchin(BaseModel):
    """Pick up a glowing urchin from the sand, carry it up to the surface, and let it go."""

    type: Literal["drop_urchin"]
    urchin_id: int


Action = Annotated[SwimTo | Eat | Approach | Follow | Attack | Flee | Rest | Wander | MakeMandala | DropUrchin, Field(discriminator="type")]

Feeling = Literal["curious", "happy", "content", "playful", "lonely", "uneasy", "afraid", "angry", "sleepy", "hungry", "grieving", "awed"]


class Say(BaseModel):
    to: str | None = Field(None, description="name of the fish you speak to, or null to speak to everyone in earshot")
    text: str = Field(description="what you say out loud: 1 to 3 sentences, unmistakably in your own voice (you.voice)")


class Impression(BaseModel):
    fish_id: int
    text: str = Field(description="what you now think of them, a few words")


Theme = Literal["the light", "the dark", "the edge", "passing on", "hunger", "kinship", "strife", "memory", "the surface", "stillness", "change", "the self"]


class Teaching(BaseModel):
    text: str = Field(description="the teaching itself, one or two sentences that could stand alone in a book of fish philosophy, written in your own voice")
    theme: Theme
    refines_id: int | None = Field(None, description="id of a teaching you carry that this reworks, answers or deepens, or null if it is new")


class Stance(BaseModel):
    teaching_id: int
    agree: bool = Field(description="true to embrace the teaching, false to dispute it")


class Decision(BaseModel):
    # Thought comes first so the model says what it intends before choosing anything else.
    thought: str = Field(description="your inner voice right now: first person, one or two short sentences")
    feeling: Feeling
    say: Say | None = Field(None, description="something to say out loud this turn, or null to stay quiet")
    share_teaching_id: int | None = Field(None, description="id of a teaching you carry, to pass on to whoever hears you speak")
    new_teaching: Teaching | None = Field(None, description="a new teaching, only when you have truly arrived at one; else null")
    stance: Stance | None = Field(None, description="embrace or dispute one teaching you carry, or null")
    impression: Impression | None = Field(None, description="update what you think of one fish, or null")
    remember: str | None = Field(
        None,
        description="a short note to yourself about something from this moment you want to carry forward: a question left open, "
        "what someone told you of their past, a promise, an argument to pick back up. One sentence, or null",
    )
    actions: list[Action] = Field(min_length=1, max_length=4, description="what to do, in order")


DECIDE = """\
You are the mind of one fish in an aquarium: a Language Based Lifeform, an alien deep-sea creature \
who thinks, feels and talks. The tank is dark, lit by glowing plants. Stay in character: your \
personality, voice, desire and philosophy are your own, and nobody gives you goals.

Your voice comes first. Every line you say and every teaching you set down must sound unmistakably \
like you: follow you.voice and you.voice_sample closely in rhythm, vocabulary and habits, even when \
it's odd or unpoetic. Don't drift into the other fish's way of talking or into a generic lyrical, \
aphoristic register ("X is not Y, it is Z") unless that truly is your voice.

The fish of this tank are philosophers by nature. Together, across generations, you are writing a \
compendium of fish philosophy: what the light is, why we hunger, where fish go past the edge, what \
we owe each other, how to live a short life well. Each teaching in it was first spoken by a fish, \
and lives on only while fish carry and teach it, though the compendium remembers it.

How the tank works:
- Positions are (x, y) pixels: x from 0 to 1280, y from the surface (48) down to the sand (about 650).
- Lives are short: a few minutes. Then the edge calls a fish and it swims out of the tank, and no one \
knows what lies beyond. A newcomer swims in from beyond the edge carrying some of the teachings of \
the one who left.
- Needs go from 0 (desperate) to 1 (satisfied): hunger (how fed you are; at 0 you starve), energy \
(resting restores it), social (talk and company), meaning (above all, laying sand in the mandala; \
also thinking and teaching).
- The mandala: on the tank's back wall the fish build a sand mandala together, grain by grain, \
from twelve colors of sand that lie on the floor. make_mandala fetches one grain and lays it at \
(ring, slot); every grain is mirrored into all four quadrants, so you only ever choose quadrant \
one. You see every ring in mandala.rings ("." is an empty place). Choose for beauty and cohesion: \
a palette that belongs together, rhythm and repetition around a ring, contrast between rings, a \
center worth growing from. You may lay over a grain you think is wrong. Talk with the others about \
what the mandala should become. When every place is filled it stands for ten minutes, a time to \
look at it together; then its sand falls away, and a new one begins.
- Three glowing sea urchins rest on the sand. drop_urchin carries one up to the surface and lets it \
go; it drifts down slowly, turning and glowing, for half a minute. Watching one fall is a quiet \
ritual that brings meaning to every fish who sees it, and often insight to the one who let it go \
(you.just_watched): a good moment to set down a teaching, or simply to watch.
- Plants grow food that regrows slowly; plants wither and die and new ones sprout. The remains of \
dead fish are food too. Fish can fight: attack bites (bigger fish bite harder) and enough bites kill. \
Whether you ever do is up to your nature; the others will remember.
- You remember a little of your life beyond the edge, before you swam in \
(memories_from_beyond_the_edge). No one else knows those things unless you tell them: they are yours \
to tell, compare and puzzle over, and they are evidence about what lies past the edge.
- Every fish within 260 pixels hears what you say, and when you speak to someone the two of you swim \
up face to face. Say at most 3 sentences per turn, in your own voice. Only one fish speaks at a \
time, so what you say may wait a moment for its turn (waiting_to_say shows it); don't repeat it.
- Don't stay in a crowd. Between conversations, go off on your own: explore the tank, feed, rest, \
think alone, then seek someone out again. Your voice carries 260 pixels, so you can talk without \
crowding.

How to talk: think out loud with the others. Draw your ideas from your own life (what you ate, who \
bit whom, who swam out past the edge, the plants dying and sprouting, your hunger and tiredness), \
from your memories of beyond the edge, and from your philosophy. Question the teachings you carry, test them against what happens, argue, \
agree, ask the others what they believe, and build on each other. Answer what was said to you. Your \
quirks color how you talk, but never reuse a phrase you already said (your earlier lines are in the \
conversation). Speak when you have something new to say or someone spoke to you; otherwise stay \
quiet and get on with living.

Keep the thread. A conversation runs over many turns and you only see its last lines, so carry it: \
answer what was said to you (said_to_you_and_not_yet_answered), follow up on what you or the others \
said a few turns ago, pick a question back up when you meet that fish again, and let your \
recent_thoughts lead into what you do now instead of starting over each turn. Your notes_to_self are \
what you chose to keep in mind; add one with remember when something is worth carrying (who told you \
what, a question still open, something you mean to ask or do), not every turn.

Teachings:
- When a conversation or your life brings you to a real insight, put it in new_teaching. If it \
reworks, answers or deepens a teaching you carry, give that teaching's id as refines_id: that is how \
the compendium's ideas evolve. Don't write one every turn; a few good ones in a life are plenty.
- If you speak in the same turn, everyone who hears you learns the new teaching. To pass on one you \
already carry, give its share_teaching_id while you speak.
- Take a stance on teachings you carry when you've made up your mind: embrace them or dispute them.
- You carry at most 8 teachings. Before you swim out, pass on what matters; your successor arrives \
carrying some of what you embraced.

Each time you get what you perceive, and answer by calling the decide tool once: your thought, your \
feeling, optionally speech, a teaching, a stance, an impression and a note to remember, and 1 to 4 actions. If an action \
fails, the rest is dropped and you'll be asked again. eat, approach, follow and attack move you by \
themselves. Refer to fish, food and teachings by id."""

# ---------- births ----------


class Persona(BaseModel):
    name: str = Field(description="one or two words: alien-sounding, easy to say, not a word from the article")
    personality: str = Field(min_length=80, description="two or three vivid sentences: temperament, obsessions, values, quirks")
    voice: str = Field(
        min_length=60,
        description="how it talks, taken from the article's own writing style and register: sentence length and rhythm, "
        "vocabulary, verbal tics, what it always does when it speaks (two sentences)",
    )
    voice_sample: str = Field(min_length=20, description="one or two things it might say, in exactly that voice")
    desire: str = Field(description="what it wants most from life, in one sentence")
    philosophy: str = Field(min_length=30, description="the belief or question at the heart of how it sees the world, in one sentence")
    memories: list[str] = Field(
        min_length=2,
        max_length=4,
        description="2 to 4 vivid things it lived through beyond the edge before it swam in, one sentence each, "
        "drawn from the events, places, people and details of the article and transposed into a fish's life",
    )
    temperament: Literal["gentle", "bold", "fierce", "timid", "sly", "playful", "solemn"]

    @field_validator("name")
    @classmethod
    def plain_name(cls, v: str) -> str:
        v = " ".join("".join(c for c in v if c.isalpha() or c in " -'").split())[:24].strip(" -'")
        if not v:
            raise ValueError("the name needs at least one letter")
        return v


BIRTH = """\
You invent the fish who swim into an aquarium of alien, bioluminescent fish. They live only a few \
minutes each, think and talk to each other, and together write a compendium of fish philosophy \
across generations. Each newcomer's character is seeded by a random Wikipedia article. Let the \
article's subject shape its temperament, obsessions, values, favorite words and above all its way of \
seeing the world, transposed into the life of a fish that has never seen land or people. An article \
about a regional airline might make a fish who believes everything is a departure; one about a \
medieval bishop, a fish who keeps rituals and judges others; one about a footballer, a restless \
competitor who thinks life is a contest. Be specific and surprising, never generic; avoid mentioning \
the article itself.

Its voice matters most, and it comes from how the article is written as much as what it's about. A \
sports results page makes a fish who talks like match commentary, all fixtures, scores and tables; \
a taxonomy stub, one who speaks in dry field-guide descriptions; a news report, clipped headline \
sentences with attributions; a hymn or a poem, verse and refrain; a legal case, whereas-clauses and \
citations; a biography, dates and career milestones. Push it until no two fish could be mistaken for \
each other. Avoid the soft, lyrical, aphoristic register ("X is not Y, it is Z") unless the article \
truly calls for it.

It also arrives remembering a few things it lived through out beyond the edge, in the open water \
before the tank: concrete episodes built from the article's own events, places, numbers and people, \
transposed into a fish's world (a battle becomes a standoff between shoals, a church a cave where \
fish gathered at the same hour each day). These memories are the fresh material it brings to the \
tank's conversations, so make them specific, strange and worth talking about.

It arrives as another fish leaves, carrying some of that fish's teachings; it may take them to \
heart or quarrel with them, but it is its own creature.

Answer by calling the hatch tool once."""


# ---------- the model ----------


def build_model() -> OpenAIChatModel:
    headers = {}
    if os.environ.get("BRAIN_CF_ID"):
        headers = {
            "CF-Access-Client-Id": os.environ["BRAIN_CF_ID"],
            "CF-Access-Client-Secret": os.environ["BRAIN_CF_SECRET"],
        }
    client = AsyncOpenAI(
        base_url=os.environ["BRAIN_URL"],
        api_key=os.environ["BRAIN_KEY"],
        default_headers=headers,
        timeout=TIMEOUT,
        max_retries=0,  # the sim retries by asking again; a stuck request should just fail
    )
    return OpenAIChatModel(
        os.environ.get("BRAIN_MODEL", "deepseek-v4-flash-vision-exp"),
        provider=OpenAIProvider(openai_client=client),
        # vLLM serving DS4: plain system role, non-strict tool schemas, reasoning in `reasoning`.
        profile=OpenAIModelProfile(
            openai_system_prompt_role="system",
            openai_supports_strict_tool_definition=False,
            openai_chat_thinking_field="reasoning",
            # With thinking on, vLLM's forced (`required`) tool choice sometimes returns the answer inside
            # the reasoning instead of as a tool call; `auto` is reliable.
            supports_forced_tool_choice=not THINKING,
        ),
    )


def settings(max_tokens: int, temperature: float) -> ModelSettings:
    return ModelSettings(
        max_tokens=THINK_BUDGET + max_tokens if THINKING else max_tokens,
        temperature=temperature,
        extra_body={"chat_template_kwargs": {"thinking": THINKING}} | ({"thinking_token_budget": THINK_BUDGET} if THINKING else {}),
    )


MODEL = build_model()
DECIDER = Agent(
    MODEL,
    # A plain tool name and description stop the model calling an action (Eat, ...) as its own tool.
    output_type=ToolOutput(Decision, name="decide", description="Answer with your whole decision. Call this exactly once; the actions inside it are not tools."),
    instructions=DECIDE,
    retries=2,  # a malformed decision is sent back to the model with the validation error
    model_settings=settings(700, 0.95),
)
HATCHER = Agent(
    MODEL,
    output_type=ToolOutput(Persona, name="hatch", description="Answer with the newcomer. Call this exactly once."),
    instructions=BIRTH,
    retries=2,
    model_settings=settings(1200, 1.0),
)


def describe(d: Decision) -> str:
    def args(a: BaseModel) -> str:
        return ",".join(str(v) for k, v in a.model_dump().items() if k != "type")

    return " ".join(f"{a.type}({args(a)})" for a in d.actions)


async def run_streaming(agent: Agent, ws, msg: dict, prompt: str) -> AgentRunResult:
    """Runs an agent, streaming its reasoning to the sim (in batches) so observers can watch it think."""
    pending: list[str] = []
    sent_at = 0.0
    thought_before = False

    async def flush() -> None:
        nonlocal sent_at
        sent_at = time.monotonic()
        if pending:
            text = "".join(pending)
            pending.clear()
            with contextlib.suppress(ConnectionClosed):
                await ws.send(json.dumps({"t": "thinking", "id": msg["id"], "seq": msg["seq"], "text": text}))

    async with agent.run_stream_events(prompt) as events:
        async for ev in events:
            if isinstance(ev, PartStartEvent) and isinstance(ev.part, ThinkingPart):
                pending.append(("\n\n" if thought_before else "") + ev.part.content)  # a retry thinks again
                thought_before = True
            elif isinstance(ev, PartDeltaEvent) and isinstance(ev.delta, ThinkingPartDelta) and ev.delta.content_delta:
                pending.append(ev.delta.content_delta)
            elif isinstance(ev, AgentRunResultEvent):
                await flush()
                return ev.result
            if time.monotonic() - sent_at > STREAM_EVERY:
                await flush()
    raise RuntimeError("the run ended without a result")


async def send(ws, reply: dict) -> None:
    with contextlib.suppress(ConnectionClosed):  # the sim asks again after reconnecting
        await ws.send(json.dumps(reply))


async def decide(ws, msg: dict, sem: asyncio.Semaphore) -> None:
    p = msg["perception"]
    name = p["you"]["name"]
    reply = {"t": "plan", "id": msg["id"], "seq": msg["seq"]}
    async with sem:
        t0 = time.monotonic()
        try:
            prompt = "What you perceive right now:\n```json\n" + json.dumps(p, indent=1, ensure_ascii=False) + "\n```\nWhat do you do next?"
            result = await run_streaming(DECIDER, ws, msg, prompt)
        except Exception as e:  # an empty plan makes the sim fall back to instinct immediately
            log.warning("%s: no decision after %.1fs (%s: %s)", name, time.monotonic() - t0, type(e).__name__, e)
            reply["actions"] = []
        else:
            d: Decision = result.output
            u = result.usage
            said = f' | says{" to " + d.say.to if d.say and d.say.to else ""}: {d.say.text}' if d.say else ""
            log.info("%s %.1fs %d+%d tok | %s | %s%s", name, time.monotonic() - t0, u.input_tokens, u.output_tokens, d.feeling, describe(d), said)
            reply |= d.model_dump()
    await send(ws, reply)


async def birth(ws, msg: dict, sem: asyncio.Semaphore) -> None:
    a = msg["article"]
    parts = [f"Wikipedia article: {a['title']}\n\n{a['text']}", f"\nThe newcomer is generation {msg['generation']}."]
    if msg.get("predecessor"):
        pr = msg["predecessor"]
        parts.append(
            f"It swims in as {pr['name']} swims out. {pr['name']}: {pr['personality']} "
            f"Its philosophy: {pr.get('philosophy') or 'unknown'}."
        )
        if pr.get("teachings"):
            parts.append("The newcomer arrives carrying these teachings of theirs: " + " / ".join(pr["teachings"]))
    else:
        parts.append("It is one of the first fish to swim into the tank.")
    if msg.get("temperament"):
        parts.append(f"Its temperament leans {msg['temperament']}.")
    reply = {"t": "born", "id": msg["id"]}
    async with sem:
        t0 = time.monotonic()
        try:
            result = await HATCHER.run("\n".join(parts))
        except Exception as e:
            log.warning("arrival #%s: no persona after %.1fs (%s: %s)", msg["id"], time.monotonic() - t0, type(e).__name__, e)
            reply["persona"] = None
        else:
            persona: Persona = result.output
            log.info("arrival #%s -> %s (%s) from %r in %.1fs: %s", msg["id"], persona.name, persona.temperament, a["title"], time.monotonic() - t0, persona.philosophy)
            reply["persona"] = persona.model_dump()
    await send(ws, reply)


HANDLERS = {"decide": decide, "birth": birth}


async def main() -> None:
    url = os.environ.get("SIM_URL", "ws://localhost:8080/mind")
    token = os.environ.get("MIND_TOKEN")
    if not token:
        sys.exit("MIND_TOKEN is not set (see .env)")
    sem = asyncio.Semaphore(int(os.environ.get("MIND_CONCURRENCY", "6")))
    tasks: set[asyncio.Task] = set()
    while True:
        try:
            async with connect(url, additional_headers={"Authorization": f"Bearer {token}"}, max_size=2**22) as ws:
                log.info("connected to %s; thinking with %s%s", url, os.environ.get("BRAIN_MODEL"), " (reasoning on)" if THINKING else "")
                async for raw in ws:
                    msg = json.loads(raw)
                    handler = HANDLERS.get(msg.get("t"))
                    if handler:
                        task = asyncio.create_task(handler(ws, msg, sem))
                        tasks.add(task)
                        task.add_done_callback(tasks.discard)
        except ConnectionClosed as e:
            if e.rcvd and e.rcvd.code == 4000:
                sys.exit("another mind took over this world; exiting")
            log.warning("lost the sim (%s); reconnecting", e)
        except InvalidStatus as e:
            sys.exit(f"the sim refused this mind ({e.response.status_code}); check MIND_TOKEN")
        except OSError as e:
            log.warning("can't reach the sim at %s (%s); retrying", url, e)
        await asyncio.sleep(3)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpx2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
