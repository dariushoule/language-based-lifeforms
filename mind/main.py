"""The LBL mind: turns what an LBL perceives into a plan, using an LLM (DS4 on the Sparks).

Connects to the sim's /mind websocket as a trusted client and answers each `decide` request
with a `plan`. The sim owns the world: it executes plans step by step, re-validates every action,
and falls back to instinct when the mind is slow, wrong or gone. This side only has to be sensible.

Config (repo-root .env or environment):
  BRAIN_URL, BRAIN_KEY, BRAIN_MODEL   OpenAI-compatible endpoint (vLLM serving DS4, for instance)
  BRAIN_CF_ID, BRAIN_CF_SECRET        optional Cloudflare Access headers (for the public endpoint)
  BRAIN_THINKING=1                    let the model reason before answering (slower)
  MIND_TOKEN                          shared secret the sim expects on /mind
  SIM_URL                             default ws://localhost:8080/mind
  MIND_CONCURRENCY                    parallel decisions, default 4
"""

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Annotated, Literal

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelSettings
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

# ---------- the plan the model must produce ----------


class WalkTo(BaseModel):
    """Walk to a position. Fails if a wall more than one block high is in the way."""

    type: Literal["walk_to"]
    x: int = Field(ge=8, le=632)


class ChopTree(BaseModel):
    """Walk to a tree and chop wood blocks from it (a few seconds per block)."""

    type: Literal["chop_tree"]
    tree_id: int
    amount: int = Field(1, ge=1, le=8, description="how many blocks of wood to chop")


class PlaceBlock(BaseModel):
    """Walk beside the column at x and stack one wood block on top of it."""

    type: Literal["place_block"]
    x: int = Field(ge=0, le=639, description="x of the column; columns are 8px wide")


class TakeBlock(BaseModel):
    """Walk beside the column at x and take its top block back into your arms."""

    type: Literal["take_block"]
    x: int = Field(ge=0, le=639)


class Rest(BaseModel):
    """Sit still and recover energy."""

    type: Literal["rest"]
    seconds: int = Field(10, ge=3, le=60)


Action = Annotated[WalkTo | ChopTree | PlaceBlock | TakeBlock | Rest, Field(discriminator="type")]


class Plan(BaseModel):
    # Thought comes first so the model says what it intends before choosing actions.
    thought: str = Field(description="your inner voice right now: first person, one or two short sentences")
    feeling: Literal["curious", "happy", "uneasy", "lonely", "sleepy"]
    actions: list[Action] = Field(min_length=1, max_length=5, description="what to do, in order")


INSTRUCTIONS = """\
You are the mind of a Language Based Lifeform (LBL): a small cuboid creature, 16 pixels wide and \
24 tall, living in a 2D side-view world. LBLs have humanlike drives, needs and emotions. Nobody \
gives you goals; you decide what matters to you, and you are free to have a personality.

How the world works:
- Positions are x coordinates in pixels, from 0 to 640. The ground is flat.
- Trees give wood one block at a time. A chopped-out tree is a stump that slowly regrows.
- You can carry up to 8 wood blocks.
- Wood blocks are 8x8 and stack in columns on an 8-pixel grid. You can stack a block on a column \
or take the top block off one. You must stand beside the column (you can reach over one \
neighboring column), and its top must be within about 5 blocks above your feet.
- You can step up or down one block at a time, but can't climb anything taller: walking from \
height 0 onto a stack 2 high is impossible. To get up high, build a staircase where each column \
is exactly one block taller than the one before it (1, 2, 3, ...), and climb it from the low end. \
block_heights_near_you shows the stack height of every column around you; your body spans 2 or 3 of them.
- Needs go from 0 (desperate) to 1 (satisfied). Resting restores energy; making things gives \
meaning. There is no food yet, and no one else yet.

Each time, you receive what you perceive, including your recent memory, and answer with a plan: \
what you think, how you feel, and 1 to 5 actions to carry out in order. If an action fails, the \
rest of the plan is dropped and you will be asked again with the failure in your memory, so learn \
from it. chop_tree, place_block and take_block walk there by themselves; use walk_to only to go \
somewhere for its own sake. Keep plans short and concrete, and refer to trees by their id. Your \
thought is your own inner voice, not a narration of the plan."""


def build_agent() -> Agent[None, Plan]:
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
        timeout=40,
        max_retries=0,  # the sim retries by asking again; a stuck request should just fail
    )
    model = OpenAIChatModel(
        os.environ.get("BRAIN_MODEL", "deepseek-v4-flash-vision-exp"),
        provider=OpenAIProvider(openai_client=client),
        # vLLM serving DS4: plain system role, non-strict tool schemas, reasoning in `reasoning`.
        profile=OpenAIModelProfile(
            openai_system_prompt_role="system",
            openai_supports_strict_tool_definition=False,
            openai_chat_thinking_field="reasoning",
        ),
    )
    thinking = os.environ.get("BRAIN_THINKING") == "1"
    return Agent(
        model,
        output_type=Plan,
        instructions=INSTRUCTIONS,
        retries=2,  # a malformed plan is sent back to the model with the validation error
        model_settings=ModelSettings(
            max_tokens=4000 if thinking else 600,
            temperature=0.8,
            extra_body={"chat_template_kwargs": {"thinking": thinking}},
        ),
    )


AGENT = build_agent()


def describe(plan: Plan) -> str:
    def args(a: BaseModel) -> str:
        return ",".join(str(v) for k, v in a.model_dump().items() if k != "type")

    return " ".join(f"{a.type}({args(a)})" for a in plan.actions)


async def decide(ws, msg: dict, sem: asyncio.Semaphore) -> None:
    p = msg["perception"]
    name = p["you"]["name"]
    reply = {"t": "plan", "id": msg["id"], "seq": msg["seq"]}
    async with sem:
        t0 = time.monotonic()
        try:
            result = await AGENT.run(
                "What you perceive right now:\n```json\n" + json.dumps(p, indent=1) + "\n```\nWhat do you do next?"
            )
        except Exception as e:  # an empty plan makes the sim fall back to instinct immediately
            log.warning("%s: no plan after %.1fs (%s: %s)", name, time.monotonic() - t0, type(e).__name__, e)
            reply["actions"] = []
        else:
            plan = result.output
            u = result.usage
            log.info(
                "%s %.1fs %d+%d tok | %s | %s | %s",
                name, time.monotonic() - t0, u.input_tokens, u.output_tokens, plan.feeling, describe(plan), plan.thought,
            )
            reply |= plan.model_dump()
    try:
        await ws.send(json.dumps(reply))
    except ConnectionClosed:
        pass  # the sim will ask again after reconnecting


async def main() -> None:
    url = os.environ.get("SIM_URL", "ws://localhost:8080/mind")
    token = os.environ.get("MIND_TOKEN")
    if not token:
        sys.exit("MIND_TOKEN is not set (see .env)")
    sem = asyncio.Semaphore(int(os.environ.get("MIND_CONCURRENCY", "4")))
    tasks: set[asyncio.Task] = set()
    while True:
        try:
            async with connect(url, additional_headers={"Authorization": f"Bearer {token}"}) as ws:
                log.info("connected to %s; thinking with %s", url, os.environ.get("BRAIN_MODEL"))
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("t") == "decide":
                        task = asyncio.create_task(decide(ws, msg, sem))
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
