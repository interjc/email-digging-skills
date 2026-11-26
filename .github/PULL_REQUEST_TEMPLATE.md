## Summary

<!-- Describe what this PR changes and why. -->

## Related issue

<!-- Link any related issue, e.g. Closes #123 -->

## Checklist

- [ ] `pnpm typecheck` passes (erasable TypeScript syntax, `.ts` local imports, `import type`)
- [ ] `pnpm test` passes using synthetic `fixtures/` or `os.tmpdir()` only (no reads from `workspace/` or `.env*`)
- [ ] `node scripts/check-staged-emails.ts --all` (and `pnpm check:emails`) passes with no non-`example.*` email addresses
- [ ] Any schema changes add a new numbered migration in `schema/migrations/` without editing applied migrations, and are classified in `scripts/lib/masked-copy.ts`
- [ ] No user-specific configuration, real source names, product names, provider URLs, `config.yaml`, `.env`, or workspace artifacts are included (`git status` verified)
- [ ] Documentation and `skills/*/SKILL.md` are updated if CLI flags, outputs, or exit codes changed
