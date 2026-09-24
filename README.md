# Check Printer

Prints the payee, date, amount and amount in words onto pre-printed Philippine bank check leaves. It covers the Meatplus group of companies and keeps a shared check register, check vouchers and an audit log.

- **Frontend:** static HTML (`index.html`, `supabase-layer.js`, `config.js`), hosted on GitHub Pages.
- **Backend:** Supabase project `bom-system`. Its tables are prefixed `cp_`, and signing in uses Supabase Auth.
- **Libraries (CDN):** supabase-js 2.117.1, jsPDF 2.5.1 and SheetJS 0.18.5.

## Who can sign in

Only emails on the **Users** list (Companies & audit tab) can open the records, and administrators manage that list. Everyone signs in with the same email and password they use for the other Meatplus apps on this Supabase project. The first administrator is `itdevice@meatplus.ph`.

Every table has row level security, so the publishable key in `config.js` is safe to commit. Without a signed-in, listed user, the database returns nothing.

## Printing

Issuing a check downloads a PDF the size of the check (8" × 3"). Print it at **100% / Actual size** on the pre-printed leaf. Positions were calibrated from Meatplus Check Set 1 (BDO, Chinabank, BPI). Use **Layouts & calibration → Alignment test PDF** to fine-tune each printer.

## Safeguards (enforced in the database)

- A check number can be used only once per bank account.
- Issuing a check is one transaction: it saves the check, moves the checkbook to the next number, assigns the CV number and writes the audit log together.
- Payee, amount, date and words can't be changed after a check is issued. Void the check and issue a new one.
- Voiding requires a reason. A cleared check can't be voided, and a voided check stays voided.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app (screens, check layouts, PDF and Excel output) |
| `supabase-layer.js` | Sign-in, loading and saving to Supabase, live updates, user list |
| `config.js` | Supabase URL and publishable key |
| `supabase/001_check_printer.sql` | Database schema, security rules and functions (already applied) |

## Deploy on GitHub Pages

1. Push this folder to a GitHub repository (e.g. `itdevice2026/check-printer`).
2. In the repository, go to **Settings → Pages**, set the source to the `main` branch and the `/ (root)` folder, then save.
3. Optional custom domain: add a `CNAME` file containing e.g. `checkprinter.meatplus.ph`. Then create a DNS CNAME record pointing that name to `itdevice2026.github.io`.
4. In **Supabase → Authentication → URL Configuration**, add the site address (e.g. `https://itdevice2026.github.io/check-printer/`) to **Redirect URLs**. This lets the password-reset and sign-up emails bring people back to the app.
