"""Scripted Pydantic AI AG-UI server for ZumiBot's smoke:agui. No model key: a FunctionModel decides each reply.

"approval demo" -> calls a tool that requires approval (an AG-UI interrupt); "slow demo" -> a tool that waits 60 s;
anything else -> "pong". After a tool result it replies "done: <result>".

Never run by `npm test` or `npm run e2e`. To run it (see docs/architecture/e2e.md, smoke:agui), in a venv of its own:

    python3 -m venv /tmp/agui-smoke-venv
    /tmp/agui-smoke-venv/bin/pip install 'pydantic-ai-slim[ag-ui]==2.65.0' 'uvicorn==0.54.0'
    PYDANTIC_AI_NO_BANNER=1 /tmp/agui-smoke-venv/bin/python -m uvicorn --app-dir zumi-bot-server/e2e/fixtures \
        agui_smoke_server:app --host 127.0.0.1 --port 8765

then, from the repo root: ZUMIBOT_SMOKE_AGUI=http://127.0.0.1:8765/agent npm run smoke:agui
(uvicorn imports it by module name, so the file name has no dashes.)
"""
import asyncio

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.ui.ag_ui import AGUIAdapter


def last_user_text(messages: list[ModelMessage]) -> str:
    for m in reversed(messages):
        if isinstance(m, ModelRequest):
            for p in m.parts:
                if isinstance(p, UserPromptPart):
                    return p.content if isinstance(p.content, str) else ' '.join(str(c) for c in p.content)
    return ''


def decide(messages: list[ModelMessage]) -> ModelResponse:
    last = messages[-1]
    returns = [p for p in getattr(last, 'parts', []) if isinstance(p, ToolReturnPart)]
    if returns:
        return ModelResponse(parts=[TextPart(f'done: {returns[0].content}')])
    text = last_user_text(messages).lower()
    if 'approval demo' in text:
        return ModelResponse(parts=[ToolCallPart('delete_demo_file', {'path': 'demo.txt'})])
    if 'slow demo' in text:
        return ModelResponse(parts=[ToolCallPart('wait_a_minute', {})])
    return ModelResponse(parts=[TextPart('pong')])


def reply(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    return decide(messages)


async def stream_reply(messages: list[ModelMessage], info: AgentInfo):
    r = decide(messages)
    part = r.parts[0]
    if isinstance(part, TextPart):
        for word in part.content.split(' '):
            yield word + ' ' if word != part.content.split(' ')[-1] else word
    else:
        from pydantic_ai.models.function import DeltaToolCall
        yield {0: DeltaToolCall(name=part.tool_name, json_args=part.args_as_json_str(), tool_call_id=part.tool_call_id)}


agent = Agent(FunctionModel(reply, stream_function=stream_reply), output_type=[str, DeferredToolRequests])


@agent.tool_plain(requires_approval=True)
def delete_demo_file(path: str) -> str:
    return f'pretended to delete {path}'


@agent.tool_plain
async def wait_a_minute() -> str:
    await asyncio.sleep(60)
    return 'waited a minute'


async def run(request: Request) -> Response:
    return await AGUIAdapter.dispatch_request(request, agent=agent)


app = Starlette(routes=[Route('/agent', run, methods=['POST'])])
