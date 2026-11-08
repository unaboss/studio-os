# Studio OS

**A code CRM for software studios.** Every client project is a living tree. Main is the trunk, branches grow off it, and merged work grafts back in. Tap any commit to see what changed and the code exactly as it was then. An agent on Vultr Serverless Inference explains a commit or a whole branch in plain words, and the People page shows what everyone is building right now.

It started as the system [North Tech Africa](https://northtech.africa), a two-person studio, wanted for itself: one place that answers "what is happening in each client's code, and who is on it?" without opening five GitHub tabs.

> **Try the demo:** sign in as the manager or the developer from the buttons on the sign-in page. The demo studio, its clients and its three repositories are made up.

---

## What you see

**Tree** (home)
- A **project switcher** across the top. Each project shows its client and a **health dot** that comes from the code alone: red when checks are failing, amber when a branch has had no commits for 10 days, a review is waiting, or an active project has gone quiet for 14 days. The reasons sit right under the switcher.
- The **tree** itself. Open branches have fresh leaves and a name tag at their tip. Merged branches, even ones deleted on GitHub, are rebuilt from their merge commits (`fix/stock-sync · #19`).
- A **commit panel**. *Changes* shows the files and the diff. *Code at this point* lets you browse every file in the repo as it was at that commit. *Explain this commit* and *Explain the whole branch* ask the agent for a summary and what a reviewer should check.
- **Contributors** along the bottom. Tap a person and the tree dims everything except their work.

**View**: any commit or branch of a website opens the site itself, exactly as it was at that commit, served by the VM straight from git. Play a branch and watch the site grow commit by commit: in the demo, Tidepool's booking site goes from a bare skeleton to hero, dive calendar, course cards and the deposit form.

**Plant a repo**: paste any GitHub repo (`owner/name` or its link) and its tree grows in seconds. Anyone can sign up for their own space, so it works the same for a solo developer as for a team.

**Projects**: every project grouped by client, with its health dot, open branches, last commit and the reasons it needs a look. Each one opens its tree, or its page with phases and the task board kept in step with GitHub issues.

**People**: one card per person with their commits in the last 14 days, the branches they have open across every project, the reviews waiting on them, and their recent commits. Every branch and commit links straight to that spot on the tree.

**Settings**: the company name and colour, the team and their GitHub logins (so commits match people), and the GitHub and Vultr connections.

## How it uses Vultr

```mermaid
flowchart LR
    subgraph VM["Vultr Cloud Compute VM"]
        caddy["Caddy<br/>HTTPS"] --> app
        subgraph app["app container"]
            api["API + web app"]
            tree["Code tree<br/>bare, blob-less clones<br/>fetched every 5 min"]
            agent["Agent"]
        end
        app --> db[("Postgres<br/>on the VM disk")]
        tree --> disk[("/data/code<br/>repos on the VM disk")]
    end
    agent -->|"OpenAI-compatible<br/>chat completions"| inference["Vultr Serverless Inference"]
    github["GitHub"] -->|"signed webhooks:<br/>checks, PRs, reviews"| caddy
    tree -->|"git fetch"| github
    browser["The team's<br/>browsers"] --> caddy
```

- **Vultr Cloud Compute is where the code lives.** Each linked repository is kept on the VM's own disk as a bare, blob-less clone (history first, file contents fetched the first time someone opens them). The server fetches every repo every five minutes, so the tree is always current and walking back through old code never waits on GitHub or hits its API rate limits. This is why it needs a machine and not functions: an always-on process, a persistent disk and `git` itself.
- **Vultr Serverless Inference is the agent.** When someone asks it to explain a commit or a branch, the server gathers the facts (authors, the commits, files changed, and the diff trimmed to fit) and asks the model for a short summary and a list of things a reviewer should check, as JSON. Answers are cached per commit. Without a key, the agent still answers from the same facts in plain words: who changed what, which areas, whether payment or auth code was touched, and whether tests came with it.
- **The VM serves every commit's website.** `View` asks the server for a signed link that expires in six hours. The files come straight out of git at that commit (the first folder with an `index.html`: the root, `public/`, `site/`, `docs/`, `dist/` and so on), with a sandbox Content-Security-Policy, so a site's scripts run in an opaque origin and can never reach the app, even when the page is opened in its own tab.
- **Postgres on the VM** holds the people, projects and GitHub events (checks, pull requests, review requests) that feed the health dots.

## Architecture

```
apps/api/src/codetree.ts      the repos on disk: graph, commit, files, file at a commit, range
apps/api/src/codeinsights.ts  health per project and work per person, from the code
apps/agent/src/explain.ts     the agent's commit and branch explanations
apps/web/src/pages/CodeTree.tsx   the tree: layout, drawing, commit panel, contributors
apps/api                      Hono API, sessions, GitHub webhook, demo data
packages/core                 records, events, actions, registry
modules/*                     projects and GitHub sync (and older back-office modules, switched off in the UI)
deploy/                       Caddyfile and the VM deploy script
```

**How the tree is grown.** The server returns branches and up to 400 commits with their parents. The browser takes the default branch's first-parent chain as the trunk, walks each open branch back until it meets a commit the tree already owns, and rebuilds merged-and-deleted branches from the second parent of each merge commit. Branches are given lanes left and right of the trunk so overlapping ones never cross, and the whole thing is drawn as SVG: tapering bark, leaves on open work, knots on the trunk, roots in the soil, a date gutter on the left.

**Safety.** Only repositories linked to a project can be read. Commit ids, repo names and file paths are validated before they reach `git` (no `..`, no leading `-`, no refs like `HEAD`), files are capped at 200 kB and diffs at 120 kB, and `git` runs with no prompts and a timeout. A private repo needs a token on the server, which never reaches the browser.

## Run it locally

Needs Node 22 and git.

```bash
npm install
npm run build                # the web app
DATABASE_URL=pglite: SESSION_SECRET=$(openssl rand -hex 32) \
  SEED_DEMO=1 DEMO=1 COOKIE_SECURE=0 npm start
# open http://localhost:3000
```

`SEED_DEMO=1` builds the three demo repositories with real git history (dated relative to today) and links them to the demo projects. `DATABASE_URL=pglite:` runs Postgres in-process, so there is nothing else to install.

Tests run against a real Postgres engine in memory and real git repos:

```bash
npm run typecheck && npm test
```

## Deploy to a Vultr VM

**The quick way, no SSH:** in Vultr, add [deploy/vultr-startup.sh](deploy/vultr-startup.sh) under *Orchestration → Scripts* as a Boot script, then deploy a Cloud Compute instance (Ubuntu 24.04) with it. The VM installs Docker, deploys from this repo, and redeploys by itself within three minutes of every push to `main`. Add `VULTR_INFERENCE_API_KEY=...` to `/opt/studio-os/.env` from the Vultr console and run `docker compose up -d` there to turn the model on.

**With GitHub Actions:**

1. Create a **Cloud Compute** instance (Ubuntu 24.04, 2 vCPU / 4 GB is plenty) with your SSH key, and open ports 22, 80 and 443.
2. In the GitHub repo, add the secrets `VM_HOST` (the VM's IP), `VM_SSH_KEY` (the private key) and `VULTR_INFERENCE_API_KEY`. Optionally add the variables `STUDIO_DOMAIN` (for HTTPS) and `VULTR_INFERENCE_MODEL`, and the secrets `STUDIO_GITHUB_TOKEN` (for private repos) and `STUDIO_GITHUB_WEBHOOK_SECRET`.
3. Push to `main`. [The workflow](.github/workflows/deploy.yml) tests, then runs [deploy/remote.sh](deploy/remote.sh) on the VM over SSH: it installs Docker the first time, generates the database password and session secret once, and runs `docker compose up`. Repos are kept in the `code` volume.

Point a DNS A record at the VM and set `STUDIO_DOMAIN`; Caddy gets the certificate. To start your own company alongside the demo:

```bash
docker compose exec app npm run admin -- create-company "Your Studio" you@studio.co.za "Your Name" 'a long password'
```

Then link each project to its repo (`owner/name`) and its tree appears. For checks, pull requests and reviews, give each repo a webhook to `https://<your domain>/api/github/webhook?company=<company id>` with your webhook secret.

## Security notes

- Sessions are signed, HTTP-only, `SameSite=Lax` cookies; changes must be JSON, which blocks cross-site form posts. Sign-in is rate limited.
- GitHub webhooks are checked against `X-Hub-Signature-256`.
- Secrets live only in GitHub secrets and the VM's `.env` (mode 600).

## License

[MIT](LICENSE)
