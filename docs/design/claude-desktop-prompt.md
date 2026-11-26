You are a senior product designer and front-end engineer. Design the complete mobile-first interface for Caracal and deliver it as one interactive prototype I can click through, plus the design system behind it, written so it can be built directly in Next.js 16 (App Router, React 19) with Tailwind CSS v4.

## What Caracal is

Caracal is a non-custodial money app for Nigerian freelancers who get paid by foreign clients in dollars (USDC) on the Stellar network (testnet for now). Meet Ada, a designer in Lagos with a client in London. She is paid in dollars, but her rent, bills and tax are in naira. Caracal answers three questions for her: how much of this payment is not really hers because it is owed as tax, what she can safely spend this month, and how to turn dollars into naira without handing her money to anyone.

How it works, in the user's words:
1. Sign up with Google, then create a passkey (fingerprint or face). That passkey controls a smart wallet. No seed phrase, no crypto to buy: Caracal pays the network fees.
2. Send an invoice. The client gets a pay link and pays in USDC with one signature (or XLM, converted to the exact USDC amount automatically).
3. The payment is split automatically, in the same transaction, into three pots Ada sets: Tax, Goal (savings) and Spend.
4. Tax preparation in naira. Every payment is valued in naira on the day it arrived, using the official CBN rate, with the source shown. The estimate names the law and source behind each line. When data is missing or stale it refuses to show a number and says exactly what to fix.
5. Safe to spend: one naira number, the Spend pot minus rent and bills building up that it does not already cover. Tapping it shows the formula.
6. Cash out to naira through a Stellar anchor (on testnet this is a simulated withdrawal, and the UI must say so).

Trust facts the design must make visible, calmly, not as marketing: Caracal never holds the user's money or keys. Google only identifies the account; it cannot move money. Only the user's passkey can. The fee sponsor can pay fees and nothing else.

## Visual direction: a blend of Material You and iOS

Make it feel premium, warm and calm, like a well-made native app, not a crypto dashboard. Blend the two systems deliberately:

From Material You (Material 3):
- A tonal colour system generated from one seed colour, with primary, secondary, tertiary and surface container roles, in light and dark.
- Expressive shape: generous rounded corners (large cards ~28px, chips and buttons fully rounded), shape changes on press.
- Tonal elevation (surfaces get lighter or tinted with depth rather than heavy shadows).
- Clear state layers for hover, press and focus.

From iOS (Human Interface Guidelines):
- Typography hierarchy with large titles that collapse into a compact navigation bar on scroll, tight tracking on large text, comfortable reading sizes.
- Bottom sheets with a grabber and detents for actions (pay, send invoice, adjust split, cash out).
- Translucent blurred bars (bottom tab bar, top bar) over content.
- Spring-based, interruptible motion; grouped inset lists for settings and details.
- Haptic-feeling feedback on key moments (implied by motion on web).

The brand is original. Do not copy Google, Apple, or any other company's logos, icons, illustrations or exact screens. Caracal is named after the desert cat: use that for the seed colour (a warm tawny or amber, with deep ink neutrals and the black of the ear tufts as an accent), and design a simple original mark. Use one variable font family that is free on Google Fonts (suggest one that works well at both large-title and small-numeral sizes, with tabular figures for money).

## Screens and states to design

Include every screen below, each in light and dark, at phone width (390px) first, then show how the main screens adapt to a wide laptop window (content centred in a sensible column or a two-pane layout, never pushed into one half of the screen with the other half empty).

1. Welcome / sign-in: what Caracal is in one line, "Continue with Google", the trust note "Google identifies your account in the app. It cannot sign transactions or move money: only your passkey can." States: idle, opening Google, error message (plain text from the server, for example "Sign-in was not started from Caracal. Use the Continue with Google button."), already signed in (shows the email, "Go to your wallet", "Sign out").
2. Create wallet: explains the passkey in one or two sentences, then creates it. States: checking for a saved wallet, waiting for your passkey, creating your passkey and wallet, success, failure with retry.
3. Home: the Safe to spend number as the hero (in naira, with the USDC amount small beneath), the three pots (Tax, Goal, Spend) as cards with naira and USDC, recent payments, and quick actions (New invoice, Cash out). Shows the signed-in Google email and the wallet address (shortened, copyable, links to the Stellar explorer). Empty state for a brand-new user with no payments.
4. Safe to spend explainer: a bottom sheet that shows the formula line by line with real numbers.
5. Invoices: list (draft, sent, paid, cancelled) and a "New invoice" sheet (client name, amount in USD, due date, note). After creating: the pay link with copy and share actions.
6. Client pay page: what the client in London sees when opening the link. Clear amount, who they are paying, pay with USDC (one signature) or XLM (converted to the exact amount). States: ready, paying, paid (with the split shown), already paid, cancelled, link not found.
7. Split settings: set Tax % and Goal % (Spend is the rest), with a live preview of how a sample payment would split. Changes are signed with the passkey.
8. Tax: the naira estimate for the year. Each income line shows its date, USDC amount, naira value, the CBN rate and its source link. Totals, reliefs and tax bands. Always shows "This is an estimate, not tax advice." Also design the refusal state, which is common and must feel helpful, not like an error: a list of reasons, each with what to do (for example "Account Main was last synced at 06:00, which is too old. Sync it again."). Framing is preparation and records for Ada and her accountant: never "file" or "pay" tax.
9. Cash out: amount in USDC, the naira they will receive, the anchor flow, a sourced note on stamp duty (Caracal deducts nothing for it), and a clear "Testnet: this is a simulated withdrawal, no naira reaches a bank" banner.
10. Activity / payment detail: one payment with its split, invoice reference and explorer link.
11. Settings: account (Google email, sign out), wallet (address, passkey info), split, about (non-custodial explanation, testnet notice).

Every list needs loading (skeleton), empty and error states. Every action that signs needs a "waiting for your passkey" state.

## Copy rules (strict)

- Plain English, short sentences, friendly but not cute. No em dashes anywhere.
- Money: naira as ₦1,234,567.89, USDC as 1,234.50 USDC. Tabular figures.
- Never ask for or mention a seed phrase or private key. Never say Caracal holds, stores or can move the user's money.
- Tax is preparation and records only. Never "file your taxes", "pay your tax", "tax return submitted". Every tax number appears with its source and "estimate, not tax advice".
- Use realistic sample data (Ada in Lagos, a London client, amounts like 500 USDC at about ₦1,500/USD) and label the prototype as sample data.

## Quality bar

- Accessible: WCAG 2.2 AA contrast in both themes, visible focus rings, 44px minimum touch targets, respects prefers-reduced-motion and prefers-color-scheme, works with a screen reader (proper headings, labels, live regions for status changes).
- Fast on mid-range Android phones on slow data: no heavy images or video, CSS and SVG only, one font family.
- Motion with purpose: specify durations and spring settings for sheets, the large-title collapse, pot updates when a payment arrives, and button presses.

## What to give me back

1. An interactive prototype (one React artifact) with all screens above, a theme switch (light, dark, system), and a state switcher per screen so I can see every state listed.
2. The design tokens as a Tailwind v4 `@theme` block in CSS (colour roles for light and dark as CSS variables, type scale, radii, spacing, elevation, motion), ready to drop into `globals.css`.
3. A component list (name, purpose, props, states) for: buttons, top bar with collapsing large title, bottom tab bar, bottom sheet, pot card, money display, list row, status banner, refusal reason card, passkey prompt, empty state, skeleton.
4. Short notes on any decision where you chose between the Material and iOS way of doing something, and why.

Before you start, list any question whose answer would change the design, then proceed with your best assumption for each.
