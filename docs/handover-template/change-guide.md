# Change guide

> **Template.** Replace every `<…>` with a fact about this project.

How to make a change here without creating a second source of truth or a bypass path.

1. **Determine the owning module or domain.**
   Find the module that owns the fact you are changing, using the ownership table in
   [architecture.md](./architecture.md). If two modules seem to own it, that is the bug — resolve
   the ownership question before writing code.

2. **Find the existing Core contract.**
   Look for the contract that already expresses what you need. `<Where they live.>` Most "new"
   requirements are a new field or case on an existing contract, not a new contract.

3. **Do not create a second source of truth.**
   If the data already has an owner, read it through that owner's contract. Do not copy it into your
   module, do not cache it without an invalidation rule, and do not write to another module's
   tables.

4. **Determine the API, data and migration impact.**
   - Does an external consumer see this? → the change is an API change; see
     [contracts.md](./contracts.md).
   - Does stored data change shape? → the change needs a migration; see
     [database.md](./database.md).
   - Both are backward-compatibility questions before they are implementation questions.

5. **Implement through the public contract.**
   Inbound adapter → application → domain. The domain imports no framework and no provider type.
   Anything that reaches around the contract is a bypass path, and
   [architecture.md](./architecture.md) lists the ones that are forbidden.

6. **Select the required test layers.**
   Use the table in [testing.md](./testing.md). State in the pull request which layers apply and,
   where a layer does not, why not.

7. **Run local verification.**
   ```bash
   <./gradlew check>
   ```
   Fix it locally. A red pipeline on a shared branch costs everyone else time.

8. **Open a pull request.**
   ```bash
   git switch -c <your-initials>/<short-description>
   git commit
   git push -u origin <branch>
   ```
   Against `<default branch>`. Say what changed, which module owns it, which test layers ran, and
   which did not apply and why.

## Backward compatibility

`<The project's rule for API and schema changes: expand-then-contract, deprecation window, how a
consumer is notified.>` A change that breaks a live consumer is a rollout plan, not a commit.

## Rolling back

`<How to roll back a deploy, and what is NOT reversible — an applied migration, a published event,
a sent notification.>` Know which of those your change contains before you merge it.
