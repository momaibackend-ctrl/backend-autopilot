# Setup required

No immediate human infrastructure setup is required for the v0.5 sandbox runtime. The owner explicitly made `momaibackend-ctrl/backend-autopilot` public, GitHub Pages is active with enforced HTTPS, and Supabase plus GitHub Actions are deployed. The superadmin bearer is generated locally, kept in the ignored `.env`, and deployed only to GitHub Actions/Supabase Edge secret stores.

The sandbox Supabase project and GitHub Actions use the already authorized `momaibackend-ctrl` identity and project `qtyfdzjzmgxtrarpgcmn`. Other stored GitHub accounts were not logged out or modified.

An operator signs in at `https://momaibackend-ctrl.github.io/backend-autopilot/` by entering the allowlisted email and completing the Supabase magic-link flow. Passwords and tokens must never be copied into the repository or chat.

Future credential expiry may require the human-only OAuth, 2FA or CAPTCHA step again. Billing upgrades, production targets and `AUTONOMOUS_PRODUCTION` remain outside authorization.
