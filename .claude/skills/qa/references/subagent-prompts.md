# Sub-Agent Prompt Templates

These are the prompts the QA skill uses when dispatching work to sub-agents. Adapt the variables in angle brackets before sending.

---

## Standards Compliance Sub-Agent

> Check these standards compliance items for the changes on this branch:
> - <item 1>
> - <item 2>
>
> For each item, return PASS/FAIL with specific `file:line` evidence.
>
> Report format (JSON array):
> ```json
> [{"item": "...", "status": "PASS|FAIL", "evidence": "file:line excerpt", "recommendation": "..."}]
> ```

---

## Write-a-Test Sub-Agent

> Write a test file at `<path>` that covers:
> - <test case 1>
> - <test case 2>
>
> Follow the conventions in `<nearby existing test file>`.
>
> After writing, run the test suite (`<test-command>`) and report PASS/FAIL with the relevant output excerpt.

---

## Browser Verification Sub-Agent

> Using Playwright MCP, verify:
> 1. Navigate to `<URL>` — the dev server IS running (I pre-flighted it; it returned `<status>`)
> 2. Check the console for errors
> 3. <specific interactions, step by step>
>
> Report format: each check PASS/FAIL with screenshot filename or error text.
>
> Do NOT attempt to start the dev server yourself.

---

## Bug-Fix Sub-Agent

> Fix this QA issue:
>
> **Issue:** <copy the full issue block from QA-REPORT.md>
>
> Steps:
> 1. Read the relevant source file(s).
> 2. Make the minimal fix.
> 3. Run the verifying check: `<exact command from the issue>`.
> 4. If the check passes, commit atomically:
>    ```bash
>    git add <files>
>    git commit -m "fix(<scope>): <description>"
>    ```
> 5. Return JSON:
>    ```json
>    {"fixed": true|false, "commit_sha": "<sha>", "verification_output": "<last 20 lines>", "notes": "<anything unusual>"}
>    ```
>
> Constraints:
> - Do NOT fix unrelated issues.
> - Do NOT refactor beyond the minimum.
> - Max 3 attempts before returning `{fixed: false}`.
