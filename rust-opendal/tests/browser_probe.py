import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Optional

from playwright.sync_api import sync_playwright


RESULT = Path("/tmp/git-anywhere-opendal-browser-result.json")


def run_phase(playwright, profile: str, mode: str, executable: Optional[str]):
    context = playwright.chromium.launch_persistent_context(
        profile,
        headless=True,
        executable_path=executable,
    )
    page = context.pages[0]
    page.goto(
        f"http://127.0.0.1:4173/tests/browser/?mode={mode}",
        wait_until="networkidle",
    )
    page.locator("#result").wait_for(state="visible")
    page.wait_for_function(
        "document.querySelector('#result').textContent !== 'running'",
        timeout=30_000,
    )
    payload = json.loads(page.locator("#result").text_content())
    context.close()
    if not payload.get("ok"):
        raise RuntimeError(f"browser {mode} phase failed: {payload}")
    return payload


with sync_playwright() as playwright:
    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
    with TemporaryDirectory(prefix="git-anywhere-opfs-profile-") as profile:
        write = run_phase(playwright, profile, "write", executable)
        # The persistent context is fully closed above. Re-launching Chromium
        # with the same profile proves OPFS survives a browser-process restart.
        reopen = run_phase(playwright, profile, "reopen", executable)

payload = {"ok": True, "write": write, "reopen": reopen}
RESULT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

print(json.dumps(payload, sort_keys=True))
