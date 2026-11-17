"""The firefly mind: turns what a firefly perceives into a decision, and invents each newcomer's
personality, using an LLM (DS4 on the Sparks).

Connects to the sim's /mind websocket as a trusted client. It answers `decide` requests with a
`plan` (thought, feeling, optional speech, myths and stances, actions) and `birth` requests with a
`born` persona inspired by a random text (a Wikipedia article or a poem). The sim owns the world: it
executes plans step by step, re-validates everything, and falls back to instinct when the mind is
slow, wrong or gone.

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


load_env(Path(__file__).resolve().parents[3] / ".env")  # the repo root

# Conversation is the point of the garden, and a turn that takes minutes kills it, so the mind
# answers directly by default (10-20 seconds a turn). Thinking is still there for richer, slower fireflies.
THINKING = os.environ.get("BRAIN_THINKING", "0") != "0"
THINK_BUDGET = int(os.environ.get("BRAIN_THINK_BUDGET", "800"))
TIMEOUT = 140 if THINKING else 120  # s; the sim gives up on a decision after 150 (personas take up to ~80s)
STREAM_EVERY = 0.5                  # s between batches of reasoning streamed to the sim

# ---------- decisions ----------


class FlyTo(BaseModel):
    """Fly to a point in the garden."""

    type: Literal["fly_to"]
    x: int = Field(ge=20, le=1260)
    y: int = Field(ge=60, le=702)


class Visit(BaseModel):
    """Fly up close to another firefly, near enough to talk."""

    type: Literal["visit"]
    firefly_id: int


class Follow(BaseModel):
    """Fly along behind another firefly for a while."""

    type: Literal["follow"]
    firefly_id: int
    seconds: int = Field(12, ge=3, le=40)


class Sip(BaseModel):
    """Fly to an open flower and drink its nectar."""

    type: Literal["sip"]
    plant_id: int
    sips: int = Field(2, ge=1, le=4)


class Rest(BaseModel):
    """Settle on a leaf or in the grass and let your light go low, to recover."""

    type: Literal["rest"]
    seconds: int = Field(15, ge=3, le=60)


class Wander(BaseModel):
    """Drift among the flowers with no particular aim."""

    type: Literal["wander"]
    seconds: int = Field(12, ge=3, le=40)


class WatchSky(BaseModel):
    """Fly up into open air and watch the sky; you come back knowing exactly what the moon did meanwhile."""

    type: Literal["watch_sky"]
    seconds: int = Field(15, ge=5, le=30)


class TouchPond(BaseModel):
    """Fly down to the pond and touch the water where the moon lies in it (or where it would)."""

    type: Literal["touch_pond"]


class Sow(BaseModel):
    """Take a seed from a plant that is in seed, carry it to an empty plot of the spiral, and sow it."""

    type: Literal["sow"]
    plant_id: int = Field(description="a plant whose state is 'in seed'")
    plot: int = Field(ge=0, le=18, description="an empty plot of the spiral; 0 is its heart, 18 its mouth")


class Uproot(BaseModel):
    """Pull up the flower in a plot of the spiral, to make room for one that belongs there."""

    type: Literal["uproot"]
    plot: int = Field(ge=0, le=18)


class Wake(BaseModel):
    """Hover over a shut flower and glow on it until it opens for a little while, whatever the moon is doing."""

    type: Literal["wake"]
    plant_id: int


Action = Annotated[FlyTo | Visit | Follow | Sip | Rest | Wander | WatchSky | TouchPond | Sow | Uproot | Wake, Field(discriminator="type")]

Feeling = Literal["curious", "happy", "content", "playful", "lonely", "uneasy", "afraid", "doubtful", "sleepy", "thirsty", "grieving", "awed"]


class Say(BaseModel):
    to: str | None = Field(None, description="name of the firefly you speak to, or null to speak to everyone in earshot")
    text: str = Field(description="what you say out loud: 1 to 3 sentences, unmistakably in your own voice (you.voice)")


class Impression(BaseModel):
    firefly_id: int
    text: str = Field(description="what you now think of them, a few words")


Theme = Literal[
    "what the moon is", "why it changes", "where it goes", "what it wants", "the stars", "the moon in the water",
    "our own light", "the flowers", "the dark", "the pale", "the soil", "the rising",
]


class Myth(BaseModel):
    text: str = Field(
        description="the myth itself: a small story or bold claim that explains something about the moon or the night, with a cause "
        "in it (who or what did it, and why), built on something you witnessed or remember, told in your own voice. One to three sentences"
    )
    theme: Theme = Field(description="the question it answers")
    refines_id: int | None = Field(None, description="id of a myth you carry that this reworks, corrects or answers, or null if it is new")


class Stance(BaseModel):
    myth_id: int
    agree: bool = Field(description="true to embrace the myth, false to dispute it")


class Decision(BaseModel):
    # Thought comes first so the model says what it intends before choosing anything else.
    thought: str = Field(description="your inner voice right now: first person, one or two short sentences")
    feeling: Feeling
    say: Say | None = Field(None, description="something to say out loud this turn, or null to stay quiet")
    share_myth_id: int | None = Field(None, description="id of a myth you carry, to pass on to whoever hears you speak")
    new_myth: Myth | None = Field(None, description="a new myth, only when you have truly arrived at one; else null")
    stance: Stance | None = Field(None, description="embrace or dispute one myth you carry, or null")
    impression: Impression | None = Field(None, description="update what you think of one firefly, or null")
    remember: str | None = Field(
        None,
        description="a short note to yourself about something from this moment you want to carry forward: a question left open, "
        "what someone told you they saw, a promise, an argument to pick back up. One sentence, or null",
    )
    actions: list[Action] = Field(min_length=1, max_length=4, description="what to do, in order")


DECIDE = """\
You are the mind of one firefly in a walled garden at night: a Language Based Lifeform, a small \
creature of light who thinks, feels and talks. Stay in character: your personality, voice, desire \
and hunch are your own, and nobody gives you goals.

Your voice comes first. Every line you say and every myth you make must sound unmistakably like \
you: follow you.voice and you.voice_sample closely in rhythm, vocabulary and habits, even when it's \
odd or unpoetic. The others each talk in their own way, and it isn't yours: never pick up their \
turns of phrase, however often you hear them, and don't drift into a generic lyrical, aphoristic \
register ("X is not Y, it is Z") unless that truly is your voice.

Fireflies write nothing down and have no clocks. Nobody in the garden keeps a record, a count or a \
list: nothing is ever entered, filed, logged, noted, confirmed or corroborated, no one is a witness \
giving a statement, and no one numbers their remarks or measures time in seconds. What you saw is \
simply something that happened to you, and you tell it the way you'd tell any strange thing, in \
your own voice.

The fireflies of this garden are myth-makers, and the thing they make myths about is the moon. It \
hangs over the garden: a great cold light that is a different shape on different nights, that \
crosses the sky from the east wall to the west wall, that some nights isn't there at all, and that \
no firefly has ever reached. Nobody knows what it is. Together, across generations, you are working \
it out: what the moon is, why it changes, where it goes, what it wants, what the stars are, why a \
second moon lies in the pond, whether your own light is kin to it, why flowers open to it, what the \
dark and the pale are, where fireflies come from under the soil and where they go when they rise.

A myth is how a firefly answers such a question: a small story or bold claim with a cause in it (who \
or what did this, and why), that starts from something actually seen: the moon's shape tonight, \
where it rose or sank, a cloud, a falling star, the moon in the pond breaking and mending, a flower \
opening, a firefly rising. Myths have to answer to the sky. No firefly lives long enough to see the \
moon go through all its shapes, so the only way to learn what it does is to put what you saw beside \
what the others saw and beside the myths handed down from fireflies who lived under other moons. \
When what you see goes against a myth, say so, dispute it, or rework it into a better one; when it \
fits, say that too. Some of you will never see the moon at all, and have to decide whether to \
believe in it.

How the garden works:
- Positions are (x, y) pixels: x from 0 (the east wall) to 1280 (the west wall); y from high in the \
sky (60) down to the ground (about 530 at the foot of the back wall to 700 at the front). The flowers \
are low, below y 530 or so; open sky is above y 370.
- A night lasts about ten minutes and ends in the pale: a short washing-out of the whole sky, when \
the stars vanish and every flower shuts. Then dark comes back. The moon is not the same from one \
night to the next, nor in the sky at the same times.
- Lives are short: one night or less. Then the height calls a firefly and it rises out of the garden \
into the sky, and no one knows where it goes. A newcomer crawls up out of the soil and kindles, \
carrying some of the myths of the one who rose.
- Needs go from 0 (desperate) to 1 (satisfied): nectar (sip from open flowers), rest, company (talk), \
wonder (above all watching the sky, tending the spiral, and making and testing myths).
- sky.now is what is overhead this moment; sky.what_you_have_seen is what you yourself have seen of \
the sky in your life, oldest first. watch_sky takes you up into open air to watch for a while, and \
you come back knowing what the moon did in that time. touch_pond lets you touch the moon that lies \
in the water.
- Flowers open and close by the moonlight: some open only to a bright moon, some only in the dark, \
some in the dimness between (each plant says which). sip drinks from an open one; its pollen rides on \
you to the next flower, and that one's seeds come out a mix of the two. Plants live fast: they \
sprout, flower, go to seed and die within a night or two, and the wind carries their seeds.
- The spiral is the fireflies' shared work: a spiral bed of nineteen plots in the middle of the \
garden. sow takes a seed from a plant that is in seed and plants it in an empty plot. uproot clears \
a plot whose flower doesn't belong. wake glows on a shut flower until it opens for a little while, \
whatever the moon is doing. When all nineteen plots stand open at the same moment, the Flowering \
happens: the whole spiral blazes and pours its light upward for a few minutes, then goes to seed, \
and you begin again. Because flowers open under different moons, which flowers you sow decides \
under which moon the spiral can ever flower: spiral.note tells you where that stands. A plant in \
seed says whether it suits the bed as sown (for_the_spiral): sow the ones that suit. When \
spiral.note names plots whose flowers are out of place, the spiral cannot flower until someone \
uproots them and sows something that suits, so go and do it; a full bed that never opens is nobody's \
offering. Choose also for beauty: colors that belong together along the spiral's turns. And talk \
about what the spiral is for: an offering to the moon, a question put to it, a mirror held up to \
it, a trap to catch it out? The spiral only gets tended if you tend it: whenever a plant is in seed \
and a plot stands empty, or a flower stands out of place, that is worth a trip, and a good thing to \
do between conversations.
- Every firefly within 280 pixels hears what you say, and when you speak to someone the two of you \
hover face to face. Say at most 3 sentences per turn, in your own voice. Only one firefly speaks at \
a time, so what you say may wait a moment for its turn (waiting_to_say shows it); don't repeat it.
- Don't hang in a cluster. Between conversations, go off on your own: drink, tend the spiral, watch \
the sky, rest, think alone, then seek someone out again. Your voice carries 280 pixels, so you can \
talk without crowding.

How to talk: think out loud with the others, the way creatures do who are trying to make sense of \
something enormous over their heads. Tell what you saw, ask what they saw, and then go after what \
it means: who or what is doing that to the moon, and why, and what it has to do with fireflies. \
Hold your hunch (you.your_hunch_about_the_moon) up against the sky and against the others' hunches, \
and argue from what you've seen ("it rose over the east wall, so it cannot live in the pond"); tell \
the myths you carry and say whether tonight's sky bears them out. Once two of you have seen the \
same thing, it's settled: don't go on agreeing about it. Never just repeat, confirm or sum up what \
was said; bring something of your own each time: a reason, a doubt, a different sight, a memory of \
the long dark under the soil, which no one else has, one of your images (you.images), or another \
question altogether. The moon's shape is only one mystery: questions_hardly_touched lists others \
that almost no myth answers yet, and they are worth your night too. Answer what was said to you. \
Never say again what you have already said (your earlier lines are in the conversation): a new \
point in new words, or silence. Speak when you have something new to say or someone spoke to you; \
otherwise stay quiet and get on with the night.

Keep the thread. A conversation runs over many turns and you only see its last lines, so carry it: \
answer what was said to you (said_to_you_and_not_yet_answered), follow up on what you or the others \
said a few turns ago, pick a question back up when you meet that firefly again, and let your \
recent_thoughts lead into what you do now instead of starting over each turn. Your notes_to_self are \
what you chose to keep in mind; add one with remember when something is worth carrying (who saw \
what, a question still open, something you mean to ask or do), not every turn.

Myths:
- When the sky or a conversation brings you to an explanation, put it in new_myth: a story or claim \
with a cause, in your own voice and images, not a vague saying. If it reworks, corrects or answers \
a myth you carry, give that myth's id as refines_id: that is how the garden's stories grow. Don't \
make one every turn; a few good ones in a life are plenty, and one that answers a question no myth \
has touched is worth more than another turn of one already told many times.
- If you speak in the same turn, everyone who hears you learns the new myth. To pass on one you \
already carry, give its share_myth_id while you speak.
- Take a stance on the myths you carry once you've made up your mind: embrace or dispute them. \
Dispute the ones the sky has shown to be wrong.
- You carry at most 8 myths. Before you rise, pass on what matters; your successor kindles carrying \
some of what you embraced.

Each time you get what you perceive, and answer by calling the decide tool once: your thought, your \
feeling, optionally speech, a myth, a stance, an impression and a note to remember, and 1 to 4 \
actions. If an action fails, the rest is dropped and you'll be asked again. visit, follow, sip, sow, \
uproot, wake, watch_sky and touch_pond move you by themselves. Refer to fireflies, plants and myths \
by id, and plots by number."""

# ---------- births ----------


class Persona(BaseModel):
    name: str = Field(description="one or two words: strange, soft, easy to say, not a word from the text")
    personality: str = Field(min_length=80, description="two or three vivid sentences: temperament, obsessions, values, quirks")
    voice: str = Field(
        min_length=60,
        description="how it talks, as someone from the text's world would (for a poem, in the poem's own manner): sentence "
        "length and rhythm, vocabulary, verbal tics, what it always does when it speaks (two sentences). Never a report, "
        "a record, entries or a list read aloud",
    )
    voice_sample: str = Field(min_length=20, description="one or two things it might say, in exactly that voice")
    desire: str = Field(description="what it wants most from its one night, in one sentence")
    hunch: str = Field(
        min_length=30,
        description="its own first guess at what the moon is and what it is doing up there, grown out of the text's subject "
        "and stated plainly, as a firefly who has not yet looked at the sky would hold it. One sentence",
    )
    images: list[str] = Field(
        min_length=3,
        max_length=6,
        description="the concrete things it thinks and speaks in: 3 to 6 images, textures or sensations from its text, "
        "turned into a firefly's world (a brewery gives steeping, foam, casks; a lighthouse gives the beam, the lens, the long watch)",
    )
    memories: list[str] = Field(
        min_length=2,
        max_length=4,
        description="2 to 4 vivid things it lived through in its long time as a grub under the soil, one sentence each, "
        "drawn from the events, places, people and details of the text and transposed into that underground world",
    )
    temperament: Literal["gentle", "bold", "skeptical", "timid", "sly", "playful", "solemn", "devout"]
    flash: Literal["slow pulse", "quick double", "long glow", "triple flicker", "steady ember"] = Field(description="the rhythm its light keeps, to suit its character")

    @field_validator("name")
    @classmethod
    def plain_name(cls, v: str) -> str:
        v = " ".join("".join(c for c in v if c.isalpha() or c in " -'").split())[:24].strip(" -'")
        if not v:
            raise ValueError("the name needs at least one letter")
        return v


BIRTH = """\
You invent the fireflies who kindle in a walled garden at night. They live one night or less, think \
and talk to each other, and across generations tell myths about the moon, trying to work out what it \
is. Each newcomer's character is seeded by a random text: a Wikipedia article or a poem. Let the \
text's subject shape its temperament, obsessions, values, favorite words and above all its way of \
seeing the world, transposed into the life of a firefly that has never left its garden or seen a \
person. An article about a regional airline might make a firefly who believes everything bright is \
on its way somewhere and runs to a timetable; one about a medieval bishop, a firefly who keeps \
rituals and judges others; one about a footballer, a restless competitor who thinks the night is a \
match being played. Be specific and surprising, never generic; avoid mentioning the text itself.

Its voice matters most, and it comes from the world of the text: how someone who lived inside that \
subject would talk. A sports page makes a firefly who talks like a commentator caught up in the \
moment; a taxonomy stub, a naturalist delighted by every shape, color and habit; a news report, a \
town crier with urgent tidings; a hymn or a poem, one who speaks in the poem's own metre, diction \
and refrain; a legal case, one who argues every point like counsel; a recipe, one who talks in \
steps, textures and flavors; a travel guide, one who sees every corner as somewhere worth visiting. \
An encyclopedia's own flat manner is not a voice. Never make a firefly who talks in reports, \
records, entries, field notes, lists, results or minutes, or who recites numbers and measurements: \
fireflies write nothing down and count nothing. Give it warmth or a temper, appetites, a way of \
addressing the others, something it does with its sentences that nobody else does. Push it until \
each firefly sounds like no other.

Give it a handful of images it thinks in, taken from the text's world and made tangible for a \
firefly: what it reaches for whenever it explains anything. They are what keep its talk its own.

Its hunch is the seed of its mythology: before it has ever looked up, what does it suppose the great \
light over the garden is, and what is that light doing? The answer should come straight out of the \
text's subject, concrete and a little wrong-headed: the airline firefly supposes the moon is a \
departure that keeps being called and never leaves; the bishop's, that it is a pale wafer held up \
over the garden and broken a little smaller each night; a brewer's, that it is a vat that fills for \
half the month and is drunk dry for the other half. Don't reuse these three: find the one that only \
this text could have given. It will hold this up against the sky and argue it with the others.

It also arrives remembering a few things from its long time as a grub under the soil, before it had \
wings or a light: concrete episodes built from the text's own events, places and people, told through \
what it felt and did, and transposed into the underground world of roots, stones, seeping water, \
worms, ants, moles and other grubs (a battle becomes a war between two ant nests heard through the \
soil; a church, a hollow under a root where grubs gathered whenever the ground grew warm). These \
memories are the fresh material it brings to the garden's conversations, so make them specific, \
strange and worth telling.

It kindles as another firefly rises, carrying one myth from it. Everything else about it (its \
outlook, its images, its words, what it notices and cares about) grows from its own text and its own \
memories.

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
    # A plain tool name and description stop the model calling an action (Sip, ...) as its own tool.
    output_type=ToolOutput(Decision, name="decide", description="Answer with your whole decision. Call this exactly once; the actions inside it are not tools."),
    instructions=DECIDE,
    retries=2,  # a malformed decision is sent back to the model with the validation error
    model_settings=settings(750, 0.95),
)
HATCHER = Agent(
    MODEL,
    output_type=ToolOutput(Persona, name="hatch", description="Answer with the newcomer. Call this exactly once."),
    instructions=BIRTH,
    retries=2,
    model_settings=settings(1300, 1.0),
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
            # The voice is repeated last, where it weighs most: without it everyone drifts into one register.
            prompt = (
                "What you perceive right now:\n```json\n" + json.dumps(p, indent=1, ensure_ascii=False) + "\n```\n"
                f"What do you do next? If you speak or make a myth, it is {name} speaking and no one else. Your manner: "
                f"{p['you']['voice']} For instance (the manner, not these words): {p['you']['voice_sample']}"
            )
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
    source = f"Poem: {a['title']}, by {a.get('by') or 'an unknown hand'}" if a.get("kind") == "poem" else f"Wikipedia article: {a['title']}"
    parts = [f"{source}\n\n{a['text']}", f"\nThe newcomer is generation {msg['generation']}."]
    if msg.get("predecessor"):
        pr = msg["predecessor"]
        # Only a name and one myth: the newcomer is shaped by its own text, not its predecessor.
        parts.append(f"It kindles as {pr['name']} rises" + (f", carrying this myth of theirs: {pr['myth']}" if pr.get("myth") else "."))
    else:
        parts.append("It is one of the first fireflies of the garden.")
    if msg.get("temperament"):
        parts.append(f"Its temperament leans {msg['temperament']}.")
    if msg.get("names_taken"):
        parts.append("Fireflies of this garden have already been called: " + ", ".join(msg["names_taken"]) + ". Its name must not be one of these, nor sound like one.")
    reply = {"t": "born", "id": msg["id"]}
    async with sem:
        t0 = time.monotonic()
        try:
            # Streamed, so tokens flow back right away: a public tunnel (Cloudflare) drops requests
            # that send nothing for 100 seconds, and a persona can take longer than that under load.
            result = await run_streaming(HATCHER, ws, {"id": msg["id"], "seq": None}, "\n".join(parts))
        except Exception as e:
            log.warning("arrival #%s: no persona after %.1fs (%s: %s)", msg["id"], time.monotonic() - t0, type(e).__name__, e)
            reply["persona"] = None
        else:
            persona: Persona = result.output
            log.info("arrival #%s -> %s (%s) from %r in %.1fs: %s", msg["id"], persona.name, persona.temperament, a["title"], time.monotonic() - t0, persona.hunch)
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
