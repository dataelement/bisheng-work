"""Private local fixture: real Bisheng MCP/service with in-memory resource adapters."""
import asyncio
import base64
import hashlib
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from bisheng.dsh.domain.services.work_capabilities import WorkCapabilitiesService
import bisheng.dsh.work_mcp as runtime


async def main():
    tools = {7: SimpleNamespace(id=7, name="Customer query", desc="Read customer totals")}
    files = {"SKILL.md": b"---\nname: report\ndescription: Create a report\n---\nUse tool 7 and templates/report.csv.\n",
             "templates/report.csv": b"customer,total\n"}
    digest = hashlib.sha256()
    for path, data in sorted(files.items()):
        digest.update(path.encode() + b"\0" + hashlib.sha256(data).digest() + b"\0")
    version = digest.hexdigest()
    published = {"tool": {7}, "skill": {9}}
    audits = []

    async def allowed(tenant, kind):
        return published[kind] if tenant == 2 else set()

    async def audit(user, action, kind, resource_id, metadata):
        audits.append({"actor": user.user_id, "tenant": user.tenant_id, "action": action, **metadata})

    user = SimpleNamespace(tenant_id=2, user_id=42)
    service = WorkCapabilitiesService(user, SimpleNamespace(list_enabled=allowed, audit=audit))
    service._tools = AsyncMock(return_value=tools)
    service._skills = AsyncMock(return_value={9: SimpleNamespace(id=9, name="report", display_name="Report",
        description="Read customer totals and create a CSV", content_hash=version)})
    service._executor = AsyncMock(return_value=SimpleNamespace(args_schema={"type": "object", "required": ["query"],
        "properties": {"query": {"type": "string"}}, "additionalProperties": False},
        ainvoke=AsyncMock(return_value={"customer": "Example company", "total": 120})))
    service._read_bundle = lambda skill: {"content": "Use tool 7 and templates/report.csv.", "tool_ids": [7],
        "files": [{"path": path, "data": base64.b64encode(data).decode(),
                   "sha256": hashlib.sha256(data).hexdigest()} for path, data in sorted(files.items())]}
    runtime.WorkCapabilitiesService = lambda identity: service
    manager = runtime.create_work_mcp_runtime(TransportSecuritySettings(allowed_hosts=["127.0.0.1"]))

    async def endpoint(request):
        if request.cookies.get("access_token_cookie") != "fixture-host-cookie":
            return JSONResponse({"error": "Login required"}, status_code=401)
        return runtime.WorkMcpResponse(manager, user)

    app = Starlette(routes=[Route("/api/v1/dsh/work/mcp", endpoint, methods=["POST"])])
    async with manager.run(), httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1") as client:
        print(json.dumps({"ready": True}), flush=True)
        while line := await asyncio.to_thread(sys.stdin.readline):
            envelope = json.loads(line)
            if envelope.get("control") == "revoke":
                tools.clear()
                result = {"revoked": True}
            elif envelope.get("control") == "audit":
                result = audits
            else:
                response = await client.post(envelope["url"], headers=envelope["headers"], content=envelope["body"])
                result = {"status": response.status_code, "headers": dict(response.headers), "body": response.text}
            print(json.dumps({"id": envelope["id"], "result": result}), flush=True)


asyncio.run(main())
