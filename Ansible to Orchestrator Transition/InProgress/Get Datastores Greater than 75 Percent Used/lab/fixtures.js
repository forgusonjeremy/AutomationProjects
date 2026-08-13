// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC ESTATE
// Builds fake VC:SdkConnection objects exposing only the properties the code
// under test actually reads:
//
//   conn.name
//   conn.getAllDatastores()          -> [ VcDatastore ]
//   conn.rootFolder.childEntity      -> [ VcDatacenter ]
//   datacenter.name, datacenter.datastoreFolder
//   folder.childEntity, storagePod.name, storagePod.childEntity
//   datastore.name, datastore.id, datastore.summary.{ name, type, accessible,
//       capacity, freeSpace, uncommitted, maintenanceMode }
//
// The estate deliberately contains every awkward case the retiring PowerShell
// mishandles, so the tests demonstrate the fix rather than merely asserting the
// happy path.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const GB = 1073741824;

let dsCounter = 0;

// Builds a datastore whose percentUsed lands on an EXACT two-decimal value, so
// boundary behaviour can be asserted precisely rather than approximately.
function ds(name, opts) {
    opts = opts || {};
    const capacityGB = opts.capacityGB === undefined ? 1024 : opts.capacityGB;
    const capacity   = Math.round(capacityGB * GB);
    const pct        = opts.percentUsed;

    let free;
    if (opts.rawCapacity !== undefined) {
        // Explicit override for the zero-capacity case.
        free = opts.rawFree;
    } else {
        const used = Math.round(capacity * (pct / 100));
        free = capacity - used;
    }

    const rec = {
        name: name,
        id:   'datastore-' + (++dsCounter),
        _dc:  opts.datacenter || 'DC-01',
        _pod: opts.datastoreCluster || '',
        summary: {
            name:            name,
            type:            opts.type || 'VMFS',
            accessible:      opts.accessible === undefined ? true : opts.accessible,
            capacity:        opts.rawCapacity !== undefined ? opts.rawCapacity : capacity,
            freeSpace:       free,
            uncommitted:     opts.uncommittedGB === null
                                 ? null
                                 : Math.round((opts.uncommittedGB === undefined ? 0 : opts.uncommittedGB) * GB),
            maintenanceMode: opts.maintenanceMode || 'normal'
        }
    };

    // A datastore whose summary cannot be read at all — vCenter occasionally
    // returns an object whose property access faults mid-enumeration.
    if (opts.summaryThrows) {
        Object.defineProperty(rec, 'summary', {
            get() { throw new Error('property summary is not accessible for this entity'); }
        });
    }

    return rec;
}

// Assembles rootFolder > Datacenter > datastoreFolder > [Folder|StoragePod] > Datastore
// from the _dc / _pod hints on each datastore.
function buildInventoryTree(datastores) {
    let groupCounter = 0;
    const byDc = {};

    datastores.forEach(d => {
        if (!byDc[d._dc]) byDc[d._dc] = { pods: {}, loose: [] };
        if (d._pod) {
            if (!byDc[d._dc].pods[d._pod]) byDc[d._dc].pods[d._pod] = [];
            byDc[d._dc].pods[d._pod].push(d);
        } else {
            byDc[d._dc].loose.push(d);
        }
    });

    const datacenters = Object.keys(byDc).map(dcName => {
        const entry = byDc[dcName];
        const children = [];

        Object.keys(entry.pods).forEach(podName => {
            children.push({
                id: 'group-p' + (++groupCounter),
                name: podName,
                childEntity: entry.pods[podName]
            });
        });

        // Loose datastores sit one nested folder deep, so folder recursion is
        // exercised rather than assumed.
        children.push({
            id: 'group-s' + (++groupCounter),
            name: 'Nested',
            childEntity: entry.loose
        });

        return {
            id: 'datacenter-' + (++groupCounter),
            name: dcName,
            datastoreFolder: {
                id: 'group-s' + (++groupCounter),
                name: 'datastore',
                childEntity: children
            }
        };
    });

    return { id: 'group-d1', name: 'Datacenters', childEntity: datacenters };
}

function vc(name, datastores, opts) {
    opts = opts || {};
    const conn = {
        name: name,
        url: 'https://' + name + '/sdk',
        rootFolder: opts.rootFolderThrows ? null : buildInventoryTree(datastores),
        getAllDatastores: function () {
            if (opts.connectionThrows) {
                throw new Error(opts.connectionThrowMessage ||
                    'Cannot complete login due to an incorrect user name or password.');
            }
            return datastores;
        }
    };
    if (opts.rootFolderThrows) {
        Object.defineProperty(conn, 'rootFolder', {
            get() { throw new Error('rootFolder unavailable: session not authenticated'); }
        });
    }
    return conn;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ESTATE
// ─────────────────────────────────────────────────────────────────────────────
function buildEstate() {
    dsCounter = 0;

    // ── vc01 — the ordinary cases plus the four boundary datastores ──────────
    const vc01 = vc('vc01.corp.local', [
        // Plainly critical and overcommitted: reported by old and new alike.
        ds('PROD-VMFS-014', { percentUsed: 92.97, capacityGB: 2048, uncommittedGB: 310,
                              datacenter: 'DC-EAST', datastoreCluster: 'SDRS-PROD' }),

        // 99% full but NOT overcommitted. Invisible in the old report because
        // the collection required uncommitted > freeSpace. This single row is
        // the most consequential difference in the whole transition.
        ds('PROD-VMFS-002', { percentUsed: 99.10, capacityGB: 4096, uncommittedGB: 2,
                              datacenter: 'DC-EAST', datastoreCluster: 'SDRS-PROD' }),

        // BOUNDARY: exactly 90.00%. Old logic: -gt 90 false, -lt 89.99 false. Dropped.
        ds('BOUNDARY-90-00', { percentUsed: 90.00, capacityGB: 1024, uncommittedGB: 900,
                               datacenter: 'DC-EAST' }),

        // BOUNDARY: exactly 89.99%. Old logic: -lt 89.99 false. Dropped.
        ds('BOUNDARY-89-99', { percentUsed: 89.99, capacityGB: 1024, uncommittedGB: 900,
                               datacenter: 'DC-EAST' }),

        // BOUNDARY: exactly 80.00%. Old logic: med needs -gt 80 (false),
        // low needs -lt 79.99 (false). Dropped.
        ds('BOUNDARY-80-00', { percentUsed: 80.00, capacityGB: 1024, uncommittedGB: 900,
                               datacenter: 'DC-EAST' }),

        // BOUNDARY: exactly 70.00%. Old logic never even collected it (-gt 70).
        ds('BOUNDARY-70-00', { percentUsed: 70.00, capacityGB: 1024, uncommittedGB: 900,
                               datacenter: 'DC-EAST' }),

        // Below the floor — must not appear in any band.
        ds('QUIET-VMFS-050', { percentUsed: 41.20, capacityGB: 512, uncommittedGB: 400,
                               datacenter: 'DC-EAST' })
    ]);

    // ── vc02 — collection hazards ────────────────────────────────────────────
    const vc02 = vc('vc02.corp.local', [
        // Zero capacity. The retiring script divided by this without a guard and
        // the resulting terminating error killed the entire run before any
        // report was produced.
        ds('DECOMMISSIONED-01', { rawCapacity: 0, rawFree: 0, uncommittedGB: 0,
                                  datacenter: 'DC-WEST' }),

        // Inaccessible: skipped by default, reported when includeInaccessible.
        ds('APD-VMFS-007', { percentUsed: 95.00, capacityGB: 1024, uncommittedGB: 900,
                             accessible: false, datacenter: 'DC-WEST' }),

        // vCenter publishes no uncommitted value for this type — the report must
        // say "unknown" rather than assert "not overcommitted".
        ds('NFS-ARCHIVE-01', { percentUsed: 97.50, capacityGB: 8192, uncommittedGB: null,
                               type: 'NFS41', datacenter: 'DC-WEST' }),

        // A datastore whose properties fault mid-enumeration. Must be recorded
        // and skipped, not allowed to abort the remaining datastores.
        ds('FAULTY-VMFS-099', { percentUsed: 91.00, summaryThrows: true,
                                datacenter: 'DC-WEST' }),

        // Report content is operator-supplied free text straight from vCenter.
        ds('<script>alert("xss")</script> & "quoted"',
           { percentUsed: 93.40, capacityGB: 256, uncommittedGB: 200, datacenter: 'DC-WEST' })
    ]);

    // ── vc03 / vc04 — the cross-vCenter name collision ───────────────────────
    // Both estates name their first production volume identically, which is the
    // norm when naming conventions are set per site. The retiring script's
    // Sort-Object -Unique on the NAME kept one and silently discarded the other.
    const vc03 = vc('vcb01.corp.local', [
        ds('SITE-PROD-01', { percentUsed: 94.00, capacityGB: 2048, uncommittedGB: 500,
                             datacenter: 'DC-NORTH', datastoreCluster: 'SDRS-SITE' })
    ]);
    const vc04 = vc('vcb02.corp.local', [
        ds('SITE-PROD-01', { percentUsed: 91.50, capacityGB: 2048, uncommittedGB: 500,
                             datacenter: 'DC-SOUTH', datastoreCluster: 'SDRS-SITE' })
    ]);

    // ── vc05 — unreachable ───────────────────────────────────────────────────
    const vc05 = vc('vc.corp.local', [], {
        connectionThrows: true,
        connectionThrowMessage: 'Cannot complete login due to an incorrect user name or password.'
    });

    return { vc01, vc02, vc03, vc04, vc05, all: [vc01, vc02, vc03, vc04, vc05] };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY REFERENCE IMPLEMENTATION
// A faithful transcription of the retiring PowerShell's selection and banding,
// used only to quantify the difference for the parallel-run brief. It is NOT
// part of the delivered solution.
//
//   collect : percentUsed -gt 70  AND  uncommitted -gt freespace
//   high    : percentUsed -gt 90
//   med     : percentUsed -gt 80  AND  percentUsed -lt 89.99
//   low     : percentUsed -gt 70  AND  percentUsed -lt 79.99
//   each band then piped through Sort-Object -Property Datastore -Unique
// ─────────────────────────────────────────────────────────────────────────────
function legacySelect(estateConnections) {
    const high = 90, med = 80, low = 70, medLimit = 89.99, lowLimit = 79.99;
    const collected = [];

    for (const conn of estateConnections) {
        let datastores;
        try {
            datastores = conn.getAllDatastores();
        } catch (e) {
            // The old script had no try/catch here: the run ended, and NOTHING
            // was emailed. Model that faithfully.
            return { aborted: true, abortedOn: conn.name, abortError: e.message,
                     high: [], med: [], low: [] };
        }

        for (const d of datastores) {
            let s;
            try { s = d.summary; } catch (e) {
                return { aborted: true, abortedOn: conn.name, abortError: e.message,
                         high: [], med: [], low: [] };
            }
            if (s.capacity === 0) {
                return { aborted: true, abortedOn: conn.name,
                         abortError: 'Attempted to divide by zero.',
                         high: [], med: [], low: [] };
            }
            const used = s.capacity - s.freeSpace;
            const pctUsed = Math.round((used / s.capacity) * 10000) / 100;
            const unc = s.uncommitted === null ? 0 : s.uncommitted;
            if (pctUsed > low && unc > s.freeSpace) {
                collected.push({ name: d.name, vcenterName: conn.name, percentUsed: pctUsed });
            }
        }
    }

    const uniqueByName = rows => {
        const seen = {};
        return rows.filter(r => (seen[r.name] ? false : (seen[r.name] = true)));
    };

    return {
        aborted: false,
        high: uniqueByName(collected.filter(r => r.percentUsed > high)),
        med:  uniqueByName(collected.filter(r => r.percentUsed > med && r.percentUsed < medLimit)),
        low:  uniqueByName(collected.filter(r => r.percentUsed > low && r.percentUsed < lowLimit))
    };
}

module.exports = { buildEstate, legacySelect, vc, ds, GB };
