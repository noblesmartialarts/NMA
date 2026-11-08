# Workshop e-waivers — how they work, who can see what, and how long we keep them

This describes the electronic waiver system for Noble's Martial Arts group workshops.
**The retention periods below are a starting proposal. Have NMA's attorney and insurance
carrier confirm them, along with the agreement text itself, before relying on them.**

## The documents

| Document | Stored as | Status |
|---|---|---|
| Workshop Participation Agreement, Assumption of Risk & Liability Waiver | `legal/workshop-waiver-v1.md` → `legal_documents` id `WORKSHOP-WAIVER-v1` | Draft pending legal & insurance review |
| NMA Workshop Photography & Media Consent | `legal/media-consent-v1.md` → `legal_documents` id `MEDIA-CONSENT-v1` | Draft pending legal & insurance review |

- The text is stored word-for-word with a SHA-256 fingerprint. The database **refuses any
  edit or delete** of a stored version, so every signed record always points at the exact
  words that were shown.
- The only automatic change is filling the template's bracketed blanks
  (`[Workshop Name]`, `[Participant Name]`, `[System Timestamp]`, …) on the signing page and
  the signed PDF. The agreement wording is never altered by code.

### Publishing a new version (after legal review)
1. Add the new text as `legal/workshop-waiver-v2.md`. Never edit v1.
2. Insert it into `legal_documents` with a new id (for example `WORKSHOP-WAIVER-v2`) and its
   `body_sha256`. In the same transaction, set `is_current=false` on v1 and `is_current=true`
   on v2. When the reviewed text is approved, set `status='approved'`.
3. Earlier signatures stay attached to v1. The CRM marks them "older version" so you can
   decide whether to ask anyone to re-sign. A re-signed agreement becomes a new record that
   supersedes the old one, and the old one is kept.
4. If someone has the signing page open when the version changes, the server rejects the
   submission and asks them to reload and review the new text.

## Signing rules (enforced by the server, not only the page)
- **One agreement per participant.** A mother and daughter each get their own participant
  record and their own signed agreement. Re-signing the same person (same name and date of
  birth) supersedes the earlier record rather than overwriting it.
- **Minimum required:** legal name and date of birth. Age is calculated on the workshop date.
- **Under 18:** a parent or legal guardian must enter their legal name, relationship, phone
  and email, certify their authority, and sign. A minor cannot sign for themselves.
  **18 and older:** the participant signs their own agreement.
- **Before signing:** the signer has to scroll through the full agreement. The "I've read
  it", "risk & release", and "sign electronically" boxes all start unchecked. The signature
  is the signer's typed legal name and must match the name entered.
- **Photo/video consent** is a separate YES or NO with nothing preselected. NO is the
  default for anyone who hasn't answered. YES requires a second typed signature from the
  consenting adult.
- **Recorded with each signing:**
  - agreement and media-consent versions, with their fingerprints
  - a snapshot of the workshop details
  - participant identity, plus signer identity and role
  - every acknowledgment
  - signature text and consent selection
  - UTC timestamp, IP address and browser
- **Not cleared to participate** until a complete signed agreement exists (or staff record a
  signed paper waiver). The check-in sheet prints NOT CLEARED in red.

## Who can see what

| | Public (link holders) | Staff on the CRM access list | Owner (noblesmartialarts@gmail.com) |
|---|---|---|---|
| Sign an agreement | ✓ | | |
| Roster, waiver status, NO MEDIA flag, emergency contact | | ✓ | ✓ |
| "Health note on file" flag | | ✓ | ✓ |
| Health/accommodation notes, date of birth, signing IP/device | | | ✓ |
| Signed PDFs (two-minute links) | | | ✓ |
| Delete health notes | | | ✓ |

- **Signed records, audit log and PDFs** sit in database tables with no public access and in
  a private storage bucket. Only the server can reach them, using the service key. The CRM
  never has database keys.
- **Every sensitive action is logged** in `waiver_audit`: opening a link, signing, storing
  the PDF, emailing the copy, viewing details, viewing a PDF, recording a paper waiver,
  withdrawing media consent, clearing a review flag, deleting notes.
- **The waiver link** is a random, unguessable code, one per workshop. "New link" in the
  CRM replaces it, and the old link stops working right away. The page is excluded from
  search engines and browser caches, and doesn't send its address to other sites.

## How long we keep things (proposal — confirm with attorney/insurer)

| What | Kept until | Why |
|---|---|---|
| Signed agreement + PDF, adult | 4 years after signing | Covers North Carolina's 3-year personal-injury limit, plus a margin |
| Signed agreement + PDF, minor | Later of 4 years after signing **or** the participant's 22nd birthday | A minor's time to file usually doesn't start until they turn 18 |
| Health/accommodation notes | Delete within **30 days after the workshop** | Only needed for safety on the day |
| Audit log | Same as the agreement it describes | Supports the signed record |
| Roster contact details | While the business relationship continues | Adult-class follow-up |

Each signed record stores its own `retain_until` date.

**Deleting health notes:** after the workshop, open the roster and click
**🧹 Delete health notes** (owner only). The database allows notes to be cleared but never
rewritten. The PDFs and emailed copies never contained the notes.

**Deleting expired agreements:** once a year, list records past `retain_until`:
`select id, participant_legal_name, retain_until from workshop_waivers where retain_until < current_date;`
Signed agreements can't be deleted through the app, which is deliberate. To delete expired
ones, the owner runs a reviewed SQL script in the Supabase SQL editor. The script:
- temporarily disables the `workshop_waivers_guard` trigger
- deletes the expired rows and their PDFs from the `workshop-waivers` bucket
- re-enables the trigger
- logs a `records_deleted` audit entry

Never delete a record involved in an incident, a claim, or an insurance request, whatever
its date.

**Withdrawing photo/video consent:** use **Withdraw** on the roster. It sets the participant
to NO MEDIA for future use and logs who did it and why. The original signed consent stays
on file as signed.

## Day-of checklist
1. Open the workshop roster in the CRM. The summary shows **cleared / on roster**.
2. Use **Copy not-cleared list** to send reminders the night before.
3. Print the **check-in sheet**. NOT CLEARED and NO MEDIA are in red.
4. Give the photographer the **no-media list**.
5. If someone shows up unsigned, they can sign on their phone at the door.
