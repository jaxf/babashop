# Babashop Fantasy Basketball Analytics

A lightweight analytics dashboard for Sleeper league `1401342003886714880`.

## What it shows

- Live league standings and scoring differential
- Power rankings using record, scoring, all-play performance, and recent form
- Week-by-week matchup scores
- Season superlatives (high score, low score, closest matchup, biggest blowout)
- Team pulse cards with recent form and a luck metric based on all-play expected wins

## Run it

No build step or API key is required. Open `index.html` with any static web server. For example:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Deploy

The site is completely static and can be deployed on GitHub Pages, Netlify, Vercel, or any other static host.

## Data

The browser reads public, read-only league data from the Sleeper API. The dashboard is configured for league ID `1401342003886714880` in `app.js`.
