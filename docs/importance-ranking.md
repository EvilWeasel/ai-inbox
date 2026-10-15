# Personal importance ranking

Choose **Rank with AI** to evaluate every currently unarchived item, then sort by
**Most important first** or **Least important first**. Newest and oldest sorting
remain available. Rankings persist across devices; scoring never archives items
or requests audio. Each evaluated item shows its score and short reason when
sorting by importance. Unranked items follow scored items in either direction.

Ranking is an explicit inference request using the configured Codex subscription.
It runs with tools, shell, browsing, plugins and delegated agents disabled.
Only the server-provisioned personal context databases are read, in SQLite
read-only mode. The worker takes recent authentic owner messages across providers,
excluding delegated children and server-generated orchestration messages. It uses
up to three messages per thread, at most 120 messages, from the past 14 days.
It does not discover remote computers, team/work stores or credentials. Other
personal environments require an explicitly configured source/adapter; unavailable
remote history is not implied to be covered.

Provision a private JSON file and set `INBOX_RANKING_CONFIG` to its absolute path
in the existing private runtime configuration (export it). Fields:
`codexExecutable` (existing absolute Codex CLI), `model` (default `gpt-6-luna`),
`contextDatabases` (explicit array of personal T3 SQLite database paths),
`preferences` (owner reading preferences). No credentials belong in this file.
The existing CLI login is used. Python 3 is required; `INBOX_PYTHON` can select it.

The private API is `GET /api/ranking` and same-origin JSON `POST /api/ranking`
with `{}`. POST deduplicates simultaneous requests through a unique running-job
constraint. The worker scores batches against a shared title catalog and common
absolute rubric. Item bodies are limited to the first 6,500 characters, so long
reports may be imperfectly represented. Scoring is subjective and can vary.
The run records model, source/message counts, newest message time and snapshot
coverage. Item changes invalidate scores; newly arrived items are unranked.
Publication of validated scores is atomic and skips items edited or archived
during inference. Failures retain previous scores. Interrupted runs can be retried
after 30 minutes. No automatic retries or scheduled rankings are installed.

Ranking sort cursors bind to the completed ranking generation. If ranking changes
while paginating, reload the list rather than mixing generations.
