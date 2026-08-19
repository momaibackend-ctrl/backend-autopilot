# Setup required

Docker is not required.

Current unavoidable human boundary for the first live sandbox:

1. Confirm whether the currently active GitHub identity `oopsie-star` is a dedicated Backend Autopilot sandbox account with no production access. If not, perform the official `gh auth login` or `gh auth switch` flow for such an account.
2. Perform `supabase login` using a dedicated sandbox account, including OAuth/2FA/CAPTCHA if requested.
3. Confirm any provider billing/payment prompt if Supabase project creation requires it.
4. If Auth/Storage Management API live tests are required, complete the official scoped Supabase token/OAuth issuance flow. The value must be placed directly into the protected secret environment as `SUPABASE_ACCESS_TOKEN`, never pasted into chat, artifacts, or repository files.

After these identity/security confirmations, the agent can discover the sandbox organization, create repository/database resources, store secret references, apply migrations, push, observe CI, run repair, and write manifests without manual developer setup.
