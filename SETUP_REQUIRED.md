# Setup required

Supabase and GitHub Actions require no further authorization. GitHub Pages activation is blocked by the current GitHub plan because `momaibackend-ctrl/backend-autopilot` is private; the official API returns HTTP 422, `Your current plan does not support GitHub Pages for this repository`.

One human decision is required: either upgrade the GitHub plan to support Pages for private repositories, or explicitly authorize making the control-plane source repository public. Backend Autopilot will not infer either billing approval or source visibility change. After that decision, rerun the `Deploy Operator Console to GitHub Pages` workflow; no code change is required.

The sandbox Supabase project and GitHub Actions use the already authorized `momaibackend-ctrl` identity and project `qtyfdzjzmgxtrarpgcmn`. Other stored GitHub accounts were not logged out or modified.

An operator signs in from the deployed console by entering the allowlisted email and completing the Supabase magic-link flow. Passwords and tokens must never be copied into the repository or chat.

Future credential expiry may require the human-only OAuth, 2FA or CAPTCHA step again. Billing upgrades, production targets and `AUTONOMOUS_PRODUCTION` remain outside authorization.
