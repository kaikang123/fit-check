# Fit Check

Will it fit? Check any garment against one you already own — before the fitting-room
queue, and before you click buy.

Sizing is inconsistent across brands and eras. A medium in one label is a large in
another. Fit Check answers a narrower question than "how does this look on me": it
compares a garment's **actual flat dimensions** against a garment you already own and
like, and says how close they are.

## How it works

Onboarding asks one question: measure the shirt that fits you best, armpit to armpit.
That single number becomes the yardstick, and it captures *how you like clothes to fit*
for free — "fits well" means oversized to one person and tailored to another.

From there you can check a garment four ways:

- **Search** a catalog of garments with published measurements
- **Scan** a price tag, care label, or barcode — one photo, all three are read
- **Enter** a brand and size by hand
- **Measure** the garment from a photo, using a credit card or A4 sheet for scale

Every verdict shows a fit gauge, an explicit confidence level, and the reasoning behind
it — including when the answer is only a size-chart estimate.

## It learns your fit, not an average one

Log how garments you own actually fit, or answer "did it fit?" after a check, and the
app learns per-brand corrections **for you specifically**. Two people with identical
measurements get different answers, because the model only ever sees their own data.
Nothing is averaged across users; nothing leaves your device.

## Honest limitations

- **Tags never carry dimensions.** No label prints pit-to-pit. A tag tells us *what*
  the garment is; measurements come from the brand's published sizing, or from
  measuring it yourself.
- **Size charts describe bodies, not garments.** Chart-derived verdicts are estimates
  and are labelled as such. The `calibrate.html` workbench exists to measure how far
  off they actually are — the fit bands have not yet been validated against real
  garments.
- **Body scanning is preliminary.** Phone-based scans land a few centimetres off a
  tape measure, which is wider than the fit bands. Scan-derived profiles are flagged
  and automatically lose confidence until a real garment replaces them.
- **Fit is not the whole dressing room.** Comfort, drape, and how you feel in
  something are out of scope. The claim is narrower and still useful: skip the queue
  for the items that clearly won't work.

## Running it

No build step and no dependencies. Serve the folder over HTTP:

```bash
python -m http.server 5173
```

Then open `http://localhost:5173/`. Camera features need a secure context, so they
work on `localhost` or over HTTPS, but not over plain HTTP on a local network — the
app says so rather than failing silently.

- `tests.html` — 135 assertions covering the measurement maths, the comparison engine,
  tag parsing, and the calibration statistics
- `calibrate.html` — record tape-measured garments against predictions to find out
  whether the fit bands are honest

All data is stored in the browser's localStorage. There is no backend and no account.
Export a backup from Profile → Settings before clearing browser data.
