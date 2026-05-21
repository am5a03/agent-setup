# Pre-commit hooks

Reusable husky `pre-commit` hooks. Copy the right one into your project's `.husky/pre-commit`.

```
pre-commit-hooks/
├── biome/pre-commit      # For projects using Biome (pnpm check:staged)
└── prettier/pre-commit   # For projects using Prettier (npx prettier --write)
```

Both hooks share the same robust pattern:

1. **Collect** only staged files (`git diff --cached --name-only --diff-filter=ACMR`)
2. **Format** using the project's formatter
3. **Re-stage** only the files that were actually changed on disk (avoids touching the index unnecessarily)
4. **Retry** `git add` up to 20 × 100 ms to survive brief `.git/index.lock` contention from editors

## biome/pre-commit

**Requires:** `husky`, `@biomejs/biome` (pnpm project)

Expects a `check:staged` script in `package.json`:

```json
"check:staged": "biome check --write --staged --no-errors-on-unmatched"
```

No extension filtering needed — Biome ignores unsupported files automatically.

**Install:**

```bash
pnpm add -D husky @biomejs/biome
cp path/to/biome/pre-commit .husky/pre-commit
chmod +x .husky/pre-commit
```

## prettier/pre-commit

**Requires:** `husky`, `prettier` (npm/npx project)

Filters staged files to Prettier-supported extensions before running:
`.ts .tsx .js .jsx .mjs .cjs .json .css .md .mdx .yaml .yml`

Reads your project's `.prettierrc` / `prettier.config.*` automatically.

**Install:**

```bash
npm install --save-dev husky prettier
npx husky init
cp path/to/prettier/pre-commit .husky/pre-commit
chmod +x .husky/pre-commit
```
