# Setting up sync

Fit Check works entirely offline and stores everything on the device. Sync is
optional, off by default, and turning it on is the one change that moves your
measurements and photos off your phone.

Sync uses a free Supabase project that **you** own. There are no accounts and
no passwords — devices pair with a long random *sync key* that you generate on
one device and type on the other.

---

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) and create a new project
   (the free tier is enough — this stores kilobytes).
2. Once it finishes provisioning, go to **Project Settings → API** and copy:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public key** — a long `eyJhbGci...` string

The anon key is designed to be public, which is why it is safe to paste into an
app whose source is on GitHub. What actually protects your data is the SQL
below.

## 2. Run this SQL

Open **SQL Editor** in Supabase, paste the whole block, and run it.

```sql
-- One row per sync key. The key itself is never stored, only its hash, so a
-- database leak does not hand over the ability to read anyone's data.
create table if not exists public.sync_state (
  key_hash    text primary key,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Row-level security ON with NO policies: the anon key cannot read or write
-- this table directly, so nobody can dump it. All access goes through the two
-- functions below, which only ever touch the row matching the key they are
-- given.
alter table public.sync_state enable row level security;

create extension if not exists pgcrypto;

create or replace function public.sync_pull(p_key text)
returns table (payload jsonb)
language sql
security definer
set search_path = public
as $$
  select s.payload
  from public.sync_state s
  where s.key_hash = encode(digest(p_key, 'sha256'), 'hex');
$$;

create or replace function public.sync_push(p_key text, p_payload jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.sync_state (key_hash, payload, updated_at)
  values (encode(digest(p_key, 'sha256'), 'hex'), p_payload, now())
  on conflict (key_hash)
  do update set payload = excluded.payload, updated_at = now();
$$;

revoke all on function public.sync_pull(text) from public;
revoke all on function public.sync_push(text, jsonb) from public;
grant execute on function public.sync_pull(text) to anon;
grant execute on function public.sync_push(text, jsonb) to anon;
```

### Why it is built this way

The obvious design — a table the anon key can read and write, filtered by a
user id — leaks. Anyone holding the anon key (which is public) could ask for
*every* row and walk away with everyone's body measurements. Enabling
row-level security with no policies makes the table unreadable, and the two
`security definer` functions are the only doors in. Each one hashes the sync
key server-side and can only ever see the single matching row.

## 3. Turn it on

On your **first** device (whichever already has your data):

1. Profile → Settings & data → **Sync across devices**
2. Paste the Project URL and anon key
3. Press **Generate a sync key**, then **Turn on sync**

On your **second** device:

1. Same screen, same URL and anon key
2. Type in the **same sync key** from the first device
3. **Turn on sync**

Both devices now merge into one shared picture, and keep doing so
automatically.

---

## What syncing actually does

Edits merge per record rather than one device overwriting the other. If you log
five garments in a shop while your laptop sits open at home, all five arrive —
nothing is lost, in either direction, whichever device syncs first.

- **Closet logs, check history, calibration samples, measured garments** — merged
  by id, so entries from both devices combine
- **Reference garments** — the more recently edited copy of a given garment wins
- **Name, fit preference, active reference, units** — genuinely single-valued, so
  the most recent change wins
- **Deletions** — recorded as tombstones, so something you delete on your phone
  does not reappear from your laptop

Syncing twice in a row changes nothing the second time, and merging is
symmetric: both devices reach the same answer regardless of order.

## Privacy

Be clear-eyed about the trade. With sync off, nothing leaves the device. With it
on, your profiles, body measurements, garment photos and logs are stored in
your Supabase project.

- The data sits in **your** project, not on any server of mine
- The sync key is stored only on your devices; the server keeps a SHA-256 hash
- Anyone who obtains your sync key can read and overwrite that data — it is the
  entire credential, so treat it like a password
- To stop syncing, press **Turn off sync**. To erase the cloud copy, delete the
  row in the Supabase table editor, or delete the project

## If it does not connect

- **404 on `sync_pull`** — the SQL has not been run, or was run on a different project
- **401 / "Invalid API key"** — the anon key is wrong or truncated
- **Nothing arrives on the second device** — the sync keys differ; they must match exactly
- **"Offline"** — expected in shops with no signal; it catches up when you reconnect
