# User Guide — Move Archived Logs

Moves archived event logs off the servers in an Active Directory group and onto the
archive share, into a folder named after each server.

**Workflow:** Production → Servers → Windows → Event Log Management → **Move Archived Logs**

---

## Running it

1. Open the workflow and click **Run**.
2. Under **Servers**, browse to the AD group holding the servers you want.
3. Click **Submit**.

That is the whole thing. Everything else is already filled in, and you are never asked
which domain — the group you picked already says.

The first run is a **report only** run. It lists what it would move and changes nothing.
Read the list, and if it looks right, run it again with **Report only** unticked.

---

## The fields

**Servers**

| Field | |
|---|---|
| AD group | The group of servers. Browse to it — there is nothing to type. |

**What to move**

| Field | Default | |
|---|---|---|
| File filter | `Archive-*.evtx` | Which files. |
| Older than days | `0` | Only files last written more than this many days ago. `0` means every age. |
| Source path | `C$\Windows\System32\winevt\Logs` | Where on each server to look. |

**Where to**

| Field | Default | |
|---|---|---|
| Target path | your archive share | A folder per server is created underneath it. |

**Options**

| Field | Default | |
|---|---|---|
| Report only | **on** | Lists what would move, changes nothing. |
| Overwrite existing | off | Off means a file already at the destination is left alone and reported. |

**Advanced** — normally leave alone.

| Field | |
|---|---|
| PowerShell host | Filled in automatically when only one is set up. |
| AD group DN | For scheduled runs, which cannot browse to a group. |

---

## Reading the result

| Output | |
|---|---|
| `success` | True when nothing errored. |
| `serversProcessed` | How many servers were done, out of how many were in the group. |
| `filesMoved` | Total files. In a report-only run, how many *would* move. |
| `transcript` | The full log. |

**`success` is false but files moved.** Normal, and not a failure. Some servers worked and
some did not — usually one was switched off. The workflow always does what it can and
reports the rest; the failed servers are listed at the end of the log.

---

## If something looks wrong

| What you see | What it usually is |
|---|---|
| **Every** server "not reachable" | An infrastructure problem, not your input. Send the log to whoever set the workflow up. |
| **One** server "not reachable" | That server is off or unreachable. It will be picked up next run. |
| "contains no enabled computer accounts" | Wrong group, or a group of users rather than servers. |
| A server you expected is missing | Its computer account is disabled — the log says so by name — or it is not in the group. |
| "destination file already exists" | It was moved before. Tick **Overwrite existing** if you want it replaced. |

---

## Two things that changed from Ansible

**Older than days now counts the way it reads.** A bigger number moves *fewer* files.
Under Ansible it did the opposite, and the normal setting was `-1`. **`-1` is now rejected**
— use `0` for "every age".

**Counts are right.** Ansible reported exactly twice the real number of files. If this
looks like it is moving half as much as it used to, it is not: it was always this many.
