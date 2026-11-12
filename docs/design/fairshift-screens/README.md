# FairShift design reference (10 Nov 2026)

These are the approved screen designs for FairShift. Use them as the design source of truth when building the real app.

- **Each `*.dc.html` file is one screen.** Open it in a browser to read its layout and copy. The `<script data-dc-script>` block at the bottom is mockup interactivity only; don't copy it into the app.
- **`fairshift.css`** holds the design tokens and component classes: colours, type scale, buttons, chips, the app shell, tables, forms and the phone layout. Port these into the app's styling.
- **`canvas.json`** lists the screens and their titles.
- **`CONTROL-MAP.txt`** lists every in-page button and the result it shows in the mockup. Each of those results is the real behaviour the app must perform.

Mockup values (Jacaranda Table, Rosebank, R45.00, the dates, the people) are demo persona data. Never hardcode them.
