# Guided Swarm setup

Use this conversation when installation or repository setup is missing. Read the
detected package manager, dependency owner, existing policy/integrations and known
telemetry preference first. No CLI execution or installation is needed to offer
setup. An empty index does not prevent installation: discuss the scan target only
after setup, when a scan is possible.

Return the opening question and menu directly, following the template below.
Do not add an inspection inventory, a failed-scan explanation, or an extra recap
around it. Inspection informs the options rather than becoming another report.
For an orphaned copy, add only that an incomplete installation needs repair. For
an installed CLI, replace the opening with **"Zedbee Swarm is installed.
Let's finish setting it up."** Mention a
prerequisite only when it actually prevents installation.

Then explain the choices below. Use a native selection tool if the host provides
one, with numbered labels and the same choices. Otherwise print this compact menu
in the conversation. Offer the menu directly; do not ask for an initial yes/no
before showing it. The example is for a fresh GitHub repository:

> Zedbee Swarm isn't installed. Would you like me to install it?
>
> Choose how to set up Swarm:
>
> **Checks**
> 1. Fast — quick checks for common code problems.
> 2. Recommended — extra checks for errors and exposed passwords or keys.
> 3. Thorough — all checks, including unused code and unsafe packages. Checks package names and versions with OSV, an online security database.
>
> **When should Swarm run?**
> 1. When I ask — no automatic checks.
> 2. Before commits — automatically check changes before each commit.
> 3. On GitHub — automatically check pull requests.
> 4. Both — before commits and on GitHub (recommended).
>
> **Help improve Swarm**
> Would you like to share anonymous usage data to help us improve Zedbee Swarm?
> 1. Yes.
> 2. No.
>
> Reply with three numbers, such as **2, 4, 2** for Recommended checks, both
> automatic options, and no usage sharing. Or reply **0** to cancel.
> I'll install Swarm using your choices. Your changes won't be committed.

Keep the short introduction as written. Save package-manager commands, dependency
locations, file paths and scan-target details for the setup review or a relevant
follow-up; do not expand the menu with them. Use everyday language rather than
analyzer names or Git jargon. Neither staged nor committed scans inspect later working edits. Do not
make the user choose a scan target just to install Swarm. Hooks mean pre-commit
and pre-merge-commit, not
pre-push. Hook and CI execution does not require an agent session.

## Adapt to the repository

- Offer GitHub CI only for a GitHub repository where workflow generation is
  supported. For another host, show manual and hooks, retaining their numbers;
  briefly explain GitHub CI is unavailable rather than promising another provider.
- If policy exists, offer **4. Keep existing checks (recommended)** in the checks
  group and summarize that policy. Preserve it unless a different profile is
  explicitly chosen. Preserve existing hook/workflow commands in every mode;
  selecting manual is not authorization to delete an existing integration. If
  integrations exist, label that option "Keep existing automatic checks" and disclose
  which existing hooks/CI will remain active.
- Match the CLI's simple invitation to share anonymous usage data; keep technical
  telemetry details in the README rather than expanding this menu question.
  Map **1. Yes** to enabled and **2. No** to disabled. Preserve an existing
  preference unless the user explicitly chooses a different one. Environment
  opt-outs remain effective: if they force telemetry off, mark Yes unavailable
  and explain once.
- Respect choices or installation authorization already given in the conversation.
  Ask only about missing choices, with numbered options. Do not replay the whole
  menu or require a second generic "go ahead" after complete choices.

## Interpret the reply and proceed

Accept comma-separated or space-separated numbers in the stated order, labeled
choices such as "checks 2, hooks 4, telemetry 2", and equivalent natural language.
`0` cancels without downloading, installing, or modifying anything. A single
"yes" authorizes installation but leaves configuration choices unanswered; ask
only for those choices. For an incomplete, invalid, conflicting, or unavailable
selection, ask only to resolve that field and keep the other selections. Never
treat a bare number as permission to guess the remaining groups.

Once choices are complete, briefly acknowledge them and follow
[the setup procedure](setup.md). The reply grants installation/configuration only
for those selections. Show the concrete CLI-generated proposal before applying,
but do not ask for the same approval again; apply the already authorized scope.
Ask again only for a newly discovered choice outside that scope, such as replacing
an incompatible custom hook or enabling project-code trust. Tool-level permission
prompts still apply.

Pass the selected profile and run integration to supported `init` options. Honor
telemetry Off before the first CLI invocation: set an environment opt-out for
initial commands and persist the preference through `zedbee telemetry disable`.
An explicit request to keep the current preference never changes it; Yes never
overrides an environment opt-out. Persist an explicit Yes selection with `zedbee telemetry enable` only
when no environment opt-out forces it off. Do not silently install hooks or CI
when the user chose manual.

Complete and verify setup even if nothing is staged. Then explain that the next
commit/PR will run the selected integration, or that a manual scan awaits a staged
proposal or explicit base comparison. Do not claim an empty scan validated code.
