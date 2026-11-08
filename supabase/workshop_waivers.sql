-- Electronic workshop waivers (Nov 2026)
-- Signed records and legal-document versions are append-only: the triggers below
-- block edits to signed content and block deletes, so history survives text changes.

create table if not exists public.legal_documents (
  id text primary key,                 -- e.g. WORKSHOP-WAIVER-v1
  kind text not null check (kind in ('workshop_waiver','media_consent')),
  version_label text not null,
  title text not null,
  body text not null,                  -- verbatim text, never edited after insert
  body_sha256 text not null,
  status text not null default 'draft-pending-review' check (status in ('draft-pending-review','approved','retired')),
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists legal_documents_one_current on public.legal_documents(kind) where is_current;
alter table public.legal_documents enable row level security;

create or replace function public.legal_documents_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Legal document versions cannot be deleted'; end if;
  if new.body is distinct from old.body or new.kind is distinct from old.kind or new.id is distinct from old.id
     or new.body_sha256 is distinct from old.body_sha256 or new.title is distinct from old.title or new.version_label is distinct from old.version_label then
    raise exception 'Legal document text is immutable — insert a new version instead';
  end if;
  return new;
end $$;
drop trigger if exists legal_documents_guard on public.legal_documents;
create trigger legal_documents_guard before update or delete on public.legal_documents
  for each row execute function public.legal_documents_guard();

alter table public.workshop_leads
  add column if not exists waiver_token text unique,
  add column if not exists public_title text;

alter table public.workshop_participants
  add column if not exists waiver_status text not null default 'Not Sent',
  add column if not exists age_category text,
  add column if not exists current_waiver_id uuid,
  add column if not exists waiver_signed_at timestamptz,
  add column if not exists paper_waiver boolean not null default false,
  add column if not exists attention_reason text;
do $$ begin
  alter table public.workshop_participants add constraint workshop_participants_waiver_status_chk
    check (waiver_status in ('Not Sent','Pending','Signed','Needs Attention'));
exception when duplicate_object then null; end $$;
update public.workshop_participants set waiver_status='Signed', paper_waiver=true where waiver_signed and waiver_status='Not Sent';

create table if not exists public.workshop_waivers (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshop_leads(id) on delete restrict,
  participant_id uuid not null references public.workshop_participants(id) on delete restrict,
  waiver_doc_id text not null references public.legal_documents(id),
  waiver_doc_sha256 text not null,
  media_doc_id text not null references public.legal_documents(id),
  media_doc_sha256 text not null,
  workshop_snapshot jsonb not null,         -- name, date, time, location, id as shown at signing
  participant_legal_name text not null,
  participant_dob date not null,
  participant_type text not null check (participant_type in ('Adult','Minor')),
  age_at_workshop integer,
  signer_legal_name text not null,
  signer_role text not null check (signer_role in ('Participant','Parent/Legal Guardian')),
  signer_relationship text,
  signer_email text,
  signer_phone text,
  emergency_contact_name text not null,
  emergency_contact_phone text not null,
  medical_notes text,                       -- sensitive: owner-only via the waiver function
  ack_read boolean not null,
  ack_liability boolean not null,
  ack_electronic boolean not null,
  signature_text text not null,
  media_consent text not null default 'No' check (media_consent in ('Yes','No')),
  media_signer_name text not null,
  media_signer_role text not null,
  media_signature_text text,
  signed_at timestamptz not null default now(),
  signer_ip text,
  signer_user_agent text,
  pdf_path text,
  pdf_sha256 text,
  emailed_copy_at timestamptz,
  superseded_by uuid references public.workshop_waivers(id),
  retain_until date not null,
  created_at timestamptz not null default now(),
  check (ack_read and ack_liability and ack_electronic)
);
create index if not exists workshop_waivers_participant_idx on public.workshop_waivers(participant_id);
create index if not exists workshop_waivers_workshop_idx on public.workshop_waivers(workshop_id);
alter table public.workshop_waivers enable row level security;

create or replace function public.workshop_waivers_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Signed waivers cannot be deleted (see WAIVERS.md retention policy)'; end if;
  -- Only bookkeeping fields may change after signing, and the PDF link only once.
  if (to_jsonb(new) - array['emailed_copy_at','superseded_by','pdf_path','pdf_sha256'])
     is distinct from (to_jsonb(old) - array['emailed_copy_at','superseded_by','pdf_path','pdf_sha256']) then
    raise exception 'Signed waiver records are immutable';
  end if;
  if old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path then raise exception 'PDF already attached'; end if;
  if old.pdf_sha256 is not null and new.pdf_sha256 is distinct from old.pdf_sha256 then raise exception 'PDF already attached'; end if;
  return new;
end $$;
drop trigger if exists workshop_waivers_guard on public.workshop_waivers;
create trigger workshop_waivers_guard before update or delete on public.workshop_waivers
  for each row execute function public.workshop_waivers_guard();

create table if not exists public.waiver_audit (
  id bigint generated by default as identity primary key,
  at timestamptz not null default now(),
  event text not null,
  workshop_id uuid,
  participant_id uuid,
  waiver_id uuid,
  actor text,
  ip text,
  user_agent text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists waiver_audit_ip_at_idx on public.waiver_audit(ip, at);
alter table public.waiver_audit enable row level security;

-- Private bucket for signed PDFs (service key only; staff get short-lived signed URLs)
insert into storage.buckets (id, name, public) values ('workshop-waivers','workshop-waivers',false)
  on conflict (id) do nothing;

insert into public.legal_documents (id, kind, version_label, title, body, body_sha256, status, is_current) values
 ('WORKSHOP-WAIVER-v1','workshop_waiver','v1 (Nov 2026 draft)','Workshop Participation Agreement, Assumption of Risk & Liability Waiver',$LEGAL$# NOBLE'S MARTIAL ARTS
## Workshop Participation Agreement, Assumption of Risk & Liability Waiver

**Noble's Martial Arts | Wake Forest, North Carolina**  
Website: noblesmartialarts.com  
Email: noblesmartialarts@gmail.com

**Workshop:** [Workshop Name]  
**Date:** [Workshop Date]  
**Location:** [Workshop Location]

### 1. Voluntary Participation

I understand that I, or the minor participant for whom I am the parent or legal guardian, am voluntarily participating in a workshop, clinic, seminar, or related training activity organized or conducted by Noble's Martial Arts ("NMA").

Activities may include martial arts instruction, practical self-defense techniques, kickboxing, controlled partner exercises, physical conditioning, striking and kicking practice using training equipment, situational awareness exercises, and simulated defensive scenarios.

Participation is voluntary. Participants may decline any exercise, request modifications, or stop participating at any time.

### 2. Acknowledgment and Assumption of Risk

I understand that martial arts, kickboxing, and self-defense training involve physical activity and inherent risks, including but not limited to:

- Bruises, soreness, muscle strains, sprains, and joint injuries.
- Accidental contact with other participants, instructors, or training equipment.
- Slips, trips, falls, and loss of balance.
- Injuries resulting from punches, kicks, blocks, grabs, releases, or other controlled defensive movements.
- Physical exertion, fatigue, dizziness, or other exercise-related complications.
- In rare circumstances, serious injury, permanent disability, or death.

I understand that NMA will take reasonable precautions to provide an appropriately supervised training environment, but no physical activity is completely free from risk.

I knowingly and voluntarily accept the inherent risks associated with participation, whether participating as an adult or authorizing participation by a minor.

### 3. Health and Physical Readiness

I confirm that I, or the minor participant, am able to participate in physical training to the best of my knowledge.

I agree to notify the instructor before participation of any injury, illness, physical limitation, or other condition that may affect safe participation, to the extent reasonably necessary for instruction and safety.

I understand that participation should be modified or avoided when appropriate based on medical advice or physical limitations.

I agree to stop participating and notify an instructor if I experience pain, dizziness, significant discomfort, or other concerning symptoms.

NMA does not provide medical advice or guarantee that any activity is suitable for every participant.

### 4. Participant Conduct and Safety

I agree that I, or the minor participant under my authorization, will:

- Follow instructor directions and workshop safety rules.
- Use only techniques authorized during the workshop.
- Exercise appropriate control during partner drills.
- Respect other participants' physical and personal boundaries.
- Stop an exercise immediately if instructed or if a partner communicates discomfort.
- Refrain from reckless, intentionally harmful, or unauthorized physical contact.
- Report unsafe conditions, injuries, or concerns to an instructor promptly.

I understand that NMA may modify or discontinue an activity, or remove a participant from an exercise or workshop, when reasonably necessary to protect the safety of others.

### 5. Release of Liability — Adult Participants

**This section applies to participants age 18 or older who sign on their own behalf.**

In consideration of being permitted to participate, I agree, to the fullest extent permitted by North Carolina law, to release and discharge Noble's Martial Arts, its owner, instructors, employees, authorized assistants, and agents from claims for bodily injury or property damage arising out of my participation in workshop activities, including claims based on ordinary negligence, to the extent such claims may lawfully be released.

This release does not apply to gross negligence, reckless misconduct, intentional wrongdoing, or any other claim that cannot lawfully be waived.

I understand that by signing this agreement, I may be giving up certain legal rights, including the right to bring a lawsuit for claims covered by this release.

### 6. Parent/Legal Guardian Authorization — Minor Participants

**This section applies to any participant under 18 years of age.**

I certify that I am the parent or legal guardian of the minor participant identified in this agreement and have legal authority to authorize participation.

I give permission for the minor to participate in the specified workshop and acknowledge that I have reviewed the workshop activities, risks, and safety expectations.

I understand that physical participation involves inherent risks, including the possibility of serious injury.

I agree to communicate relevant safety information to NMA and to instruct the minor to follow the workshop's safety rules.

To the fullest extent permitted by applicable law, I release claims that belong to me individually arising from the minor's participation, including claims based on ordinary negligence, to the extent those claims may lawfully be released.

Nothing in this agreement is intended to waive or extinguish a minor's independent legal claims where applicable law does not permit a parent or guardian to do so.

### 7. Emergency Medical Assistance

In the event of an injury or medical emergency, I authorize NMA to contact emergency medical services and provide reasonable assistance while awaiting qualified medical personnel.

For minor participants, I authorize NMA to seek emergency medical assistance if I cannot be reached promptly.

I understand that NMA instructors are not acting as medical professionals and that any medical treatment decisions will be made by appropriately qualified providers or authorized individuals.

I understand that medical expenses may be my responsibility or the responsibility of the minor participant's parent or legal guardian, subject to any applicable insurance coverage.

### 8. Educational Purpose and No Guarantee of Personal Safety

I understand that self-defense and martial arts instruction is provided for educational and personal development purposes.

No technique, workshop, or training program can guarantee prevention of injury, assault, or other harm.

Training does not replace sound judgment, situational awareness, emergency assistance, or appropriate law-enforcement and medical services.

Participants are encouraged to prioritize avoiding danger, disengaging from unsafe situations, seeking assistance, and using physical defensive techniques only when reasonably necessary and lawful.

### 9. Application to the Identified Workshop

This agreement applies to the workshop identified above, including related supervised instructional activities conducted as part of that event.

Participation in a separate workshop or event may require a new acknowledgment or agreement.

### 10. Electronic Signature and Acknowledgment

I acknowledge that:

- I have been provided the opportunity to read this agreement in its entirety.
- I understand the risks associated with participation.
- I understand the release of liability provisions applicable to me.
- I have had the opportunity to ask questions before signing.
- I voluntarily agree to the applicable terms.
- I consent to execute this agreement electronically and intend my electronic signature to authenticate my agreement.

**I HAVE READ AND UNDERSTAND THIS AGREEMENT, INCLUDING ITS ASSUMPTION OF RISK AND RELEASE OF LIABILITY PROVISIONS. I UNDERSTAND THAT SIGNING MAY AFFECT MY LEGAL RIGHTS.**

---

### Participant and Signature Information

**Participant Full Legal Name:** [Participant Name]  
**Date of Birth:** [Date of Birth]

**Participant Type:** [Adult / Minor]

**Adult Participant Signature:** [Electronic Signature, if applicable]

**Parent/Legal Guardian Full Legal Name:** [Parent/Guardian Name, if applicable]  
**Relationship to Minor:** [Relationship]  
**Parent/Legal Guardian Signature:** [Electronic Signature, if applicable]

**Date and Time Signed:** [System Timestamp]  
**Workshop ID:** [System-Generated Workshop ID]  
**Agreement Version:** [Waiver Version]
$LEGAL$,'58b7634d2b60ef22c53580870626184baf53a7e5d3594829d81e00855d380367','draft-pending-review',true),
 ('MEDIA-CONSENT-v1','media_consent','v1 (Nov 2026 draft)','NMA Workshop Photography & Media Consent',$LEGAL$NMA Workshop Photography & Media Consent
Noble's Martial Arts may photograph or record portions of workshops for educational, promotional, and marketing purposes.
Approved media may appear on NMA's website, social media accounts, printed promotional materials, or other business communications.
Media may also be created by photographers or videographers authorized by NMA.
Media consent is entirely optional and does not affect eligibility to participate in a workshop.
Please select one:

* YES — I authorize Noble's Martial Arts to photograph or record the identified participant and use their identifiable image, likeness, and voice for lawful business promotional purposes without compensation.
* NO — I do not authorize NMA to use identifiable photographs, video, or audio recordings of the identified participant for promotional purposes.

I understand that I may withdraw authorization for future use by contacting [noblesmartialarts@gmail.com](mailto:noblesmartialarts@gmail.com). Withdrawal does not necessarily remove material already distributed or shared by third parties.
Participant Name: [Participant Name]
Consent Provided By: [Adult Participant / Parent or Legal Guardian]
Full Legal Name: [Consenting Adult Name]
Electronic Signature: [Signature]
Date: [Timestamp]
$LEGAL$,'55439ba4446e9cf38c7256112a386a3ff39bf0dc9afa5f6a53c155768c651d33','draft-pending-review',true)
on conflict (id) do nothing;

-- Follow-up: guardian acknowledgment, and allow health notes to be cleared (never rewritten)
alter table public.workshop_waivers add column if not exists ack_guardian boolean;
create or replace function public.workshop_waivers_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Signed waivers cannot be deleted (see WAIVERS.md retention policy)'; end if;
  if new.medical_notes is not null and new.medical_notes is distinct from old.medical_notes then
    raise exception 'Health notes can only be cleared, not changed';
  end if;
  if (to_jsonb(new) - array['emailed_copy_at','superseded_by','pdf_path','pdf_sha256','medical_notes'])
     is distinct from (to_jsonb(old) - array['emailed_copy_at','superseded_by','pdf_path','pdf_sha256','medical_notes']) then
    raise exception 'Signed waiver records are immutable';
  end if;
  if old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path then raise exception 'PDF already attached'; end if;
  if old.pdf_sha256 is not null and new.pdf_sha256 is distinct from old.pdf_sha256 then raise exception 'PDF already attached'; end if;
  if old.superseded_by is not null and new.superseded_by is distinct from old.superseded_by then raise exception 'Already superseded'; end if;
  return new;
end $$;
