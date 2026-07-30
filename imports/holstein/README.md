# imports/holstein

Drop `holstein-batch-*.json` files here (produced by `scripts/holstein-extract.js`
running in the browser), then import them:

```bash
npm run import:holstein:demo      # all JSON files in this folder → demo DB
npm run import:holstein:prod      # → production DB
npm run import:holstein:demo -- imports/holstein/holstein-batch-12-1699999999.json  # one file
```

Each file is an array of raw animal extracts; see `src/lib/holstein-parse.ts`
(`HolsteinRawExtract`) for the shape. Importing is idempotent.
