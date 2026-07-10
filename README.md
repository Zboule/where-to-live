# Where to Live

Two tools for one relocation decision, in a single static web app — no backend, everything runs in your browser:

- **Places** 🌍 — a **Kid-Raising Score** that ranks European cities and districts. Move the weight sliders to score the places under *your* priorities (education, safe independence, nature, health…); a dealbreaker penalty punishes any critical factor that scores too low. Each row carries its cost-of-living multiplier and travel times; a map recolours live as the weighting changes.
- **Place cost** 🧳 — *"how much equity does it take to relocate here?"* For a chosen destination city and move year it projects the destination cost of life, the home's value and mortgage, and the equity portfolio (invested at a chosen return) that sustains it — to **FIRE** (portfolio covers everything) or just **mortgage-free**. City wealth taxes and per-country capital-gains tax included.

Both were extracted from a private family dashboard into a public app, the same way as its sibling [Mortgage Rider](https://zboule.github.io/mortgage-rider/). The district dataset, the scoring, the cost-of-living engine and the finance place-cost engine are all bundled at build time and computed client-side.

**Live:** <https://zboule.github.io/where-to-live/>

## Develop

```
npm install
npm run dev      # regenerates bundled data, then starts Vite
```

Open <http://localhost:5173>.

## How the data is bundled

The app carries no live API. At build time `npm run gen` turns the committed source data into the JSON the app imports:

- `scripts/gen-city.mjs` — reads `data/city/places/*.yaml` (the hand-researched district dataset) → `src/city/ranking/districts.generated.json`.
- `scripts/gen-placecost.mjs` — reads `data/placecost/config/**` (the finance config: destination living costs, relocation homes, taxes, FX) → the bundled JSON the place-cost engine reads.

Generated `*.generated.json` files are git-ignored and rebuilt by `npm run gen` (which the Pages build runs before `vite build`). The engines themselves are faithful copies of the [city-ranking](https://github.com/Zboule/city-ranking) service and the finance service's place-cost engine, with only the I/O seams (filesystem/YAML → bundled JSON, server persistence → `localStorage`) adapted for the browser.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. The Vite `base` is `/where-to-live/`.
