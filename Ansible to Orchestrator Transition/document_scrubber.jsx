import { useState, useRef, useCallback, useEffect } from "react";

const CATEGORIES = {
  ip: { label: "IP Addresses", color: "#E74C3C", icon: "⊕", regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  fqdn: { label: "FQDNs / Hostnames", color: "#3498DB", icon: "◈", regex: /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.){2,}[a-zA-Z]{2,}\b/g },
  email: { label: "Email Addresses", color: "#9B59B6", icon: "✉", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
  unc: { label: "UNC / File Paths", color: "#E67E22", icon: "⟟", regex: /(?:\\\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9 ._$-]+)+)|(?:[A-Z]:\\(?:[A-Za-z0-9 ._-]+\\)*[A-Za-z0-9 ._-]+)/g },
  custom_name: { label: "Custom Names / Identifiers", color: "#1ABC9C", icon: "⬡", regex: /\b(?:svc[A-Z][A-Za-z0-9_]+|[a-z]{2,6}(?:oew|oco|hst|mdc|ewv)[a-z0-9]{2,20})\b/gi },
  service_acct: { label: "Service Accounts", color: "#F39C12", icon: "⚙", regex: /\b(?:svc[._-]?[A-Za-z0-9_.-]{3,}|[A-Za-z]+\\[A-Za-z0-9._-]+)\b/g },
};

function parseCSV(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  const chars = text.split("");
  const row = [];

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '"') {
      if (inQuotes && chars[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if ((c === "," || c === "\t") && !inQuotes) {
      row.push(current); current = "";
    } else if ((c === "\n" || (c === "\r" && chars[i + 1] === "\n")) && !inQuotes) {
      if (c === "\r") i++;
      row.push(current); current = "";
      if (row.some(cell => cell.trim())) rows.push([...row]);
      row.length = 0;
    } else {
      current += c;
    }
  }
  row.push(current);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

function scanText(text) {
  const findings = new Map();
  for (const [catKey, cat] of Object.entries(CATEGORIES)) {
    const regex = new RegExp(cat.regex.source, cat.regex.flags);
    let m;
    while ((m = regex.exec(text)) !== null) {
      const val = m[0];
      if (!findings.has(val)) {
        findings.set(val, { value: val, category: catKey, count: 0, replacement: "" });
      }
      findings.get(val).count++;
    }
  }
  // Deduplicate: if a value matches multiple categories, keep the most specific
  const result = new Map();
  for (const [val, finding] of findings) {
    let dominated = false;
    for (const [otherVal] of findings) {
      if (otherVal !== val && otherVal.includes(val) && otherVal.length > val.length) {
        dominated = true; break;
      }
    }
    if (!dominated) result.set(val, finding);
  }
  return result;
}

function applyScrub(text, mappings) {
  let result = text;
  const sorted = [...mappings].sort((a, b) => b[0].length - a[0].length);
  for (const [original, { replacement }] of sorted) {
    if (replacement) {
      result = result.split(original).join(replacement);
    }
  }
  return result;
}

const PHASE = { UPLOAD: 0, REVIEW: 1, SCRUBBED: 2 };

export default function DocumentScrubber() {
  const [phase, setPhase] = useState(PHASE.UPLOAD);
  const [files, setFiles] = useState([]);
  const [findings, setFindings] = useState(new Map());
  const [activeCategory, setActiveCategory] = useState(null);
  const [scrubbedFiles, setScrubbedFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [filterText, setFilterText] = useState("");
  const fileInputRef = useRef(null);

  const handleFiles = useCallback(async (fileList) => {
    const newFiles = [];
    for (const file of fileList) {
      if (file.name.match(/\.(csv|tsv|txt|yml|yaml|json|xml|conf|cfg|ini|log|md|ps1|py|sh|bat|cmd)$/i)) {
        const text = await file.text();
        newFiles.push({ name: file.name, content: text, type: "text" });
      } else {
        newFiles.push({ name: file.name, content: null, type: "unsupported" });
      }
    }
    setFiles(prev => [...prev, ...newFiles.filter(f => f.type === "text")]);
  }, []);

  const runScan = useCallback(() => {
    setScanning(true);
    setTimeout(() => {
      const allFindings = new Map();
      for (const file of files) {
        const fileFindings = scanText(file.content);
        for (const [val, finding] of fileFindings) {
          if (allFindings.has(val)) {
            allFindings.get(val).count += finding.count;
          } else {
            allFindings.set(val, { ...finding });
          }
        }
      }
      setFindings(allFindings);
      setActiveCategory(Object.keys(CATEGORIES)[0]);
      setPhase(PHASE.REVIEW);
      setScanning(false);
    }, 400);
  }, [files]);

  const updateReplacement = (original, replacement) => {
    setFindings(prev => {
      const next = new Map(prev);
      next.get(original).replacement = replacement;
      return next;
    });
  };

  const autoGenerate = (catKey) => {
    setFindings(prev => {
      const next = new Map(prev);
      let idx = 1;
      for (const [val, f] of next) {
        if (f.category === catKey && !f.replacement) {
          const prefix = catKey === "ip" ? "10.0.0." : catKey === "email" ? `user${idx}@example.com` : catKey === "fqdn" ? `host${idx}.example.local` : `REDACTED_${catKey.toUpperCase()}_`;
          f.replacement = catKey === "ip" ? `${prefix}${idx}` : catKey === "email" || catKey === "fqdn" ? prefix : `${prefix}${idx}`;
          idx++;
        }
      }
      return next;
    });
  };

  const clearReplacements = (catKey) => {
    setFindings(prev => {
      const next = new Map(prev);
      for (const [, f] of next) {
        if (f.category === catKey) f.replacement = "";
      }
      return next;
    });
  };

  const executeScrub = () => {
    const mappingsWithReplacements = new Map(
      [...findings].filter(([, f]) => f.replacement)
    );
    const scrubbed = files.map(file => ({
      name: `SCRUBBED_${file.name}`,
      content: applyScrub(file.content, mappingsWithReplacements),
    }));
    setScrubbedFiles(scrubbed);
    setPhase(PHASE.SCRUBBED);
  };

  const downloadFile = (file) => {
    const blob = new Blob([file.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = file.name; a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = () => {
    scrubbedFiles.forEach(f => downloadFile(f));
  };

  const downloadMapping = () => {
    const lines = ["Original Value,Category,Replacement"];
    for (const [val, f] of findings) {
      if (f.replacement) {
        lines.push(`"${val}","${CATEGORIES[f.category].label}","${f.replacement}"`);
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "scrub_mapping.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setPhase(PHASE.UPLOAD);
    setFiles([]);
    setFindings(new Map());
    setScrubbedFiles([]);
    setActiveCategory(null);
    setFilterText("");
  };

  const categoryCounts = {};
  for (const [, f] of findings) {
    categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
  }

  const mappedCount = [...findings.values()].filter(f => f.replacement).length;
  const totalFindings = findings.size;

  const filteredFindings = [...findings.entries()].filter(([val, f]) => {
    if (activeCategory && f.category !== activeCategory) return false;
    if (filterText && !val.toLowerCase().includes(filterText.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{
      fontFamily: "'IBM Plex Mono', 'SF Mono', 'Fira Code', monospace",
      background: "var(--bg, #0a0e17)",
      color: "var(--text, #c8d6e5)",
      minHeight: "100vh",
      padding: "0",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        :root {
          --bg: #0a0e17;
          --surface: #111827;
          --surface2: #1a2234;
          --border: #1e2d44;
          --text: #c8d6e5;
          --text-dim: #5a6e82;
          --accent: #00d4aa;
          --accent-dim: rgba(0,212,170,0.1);
          --danger: #e74c3c;
          --warning: #f39c12;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input:focus, button:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: var(--surface); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .fade-in { animation: fadeIn 0.3s ease-out both; }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: "1px solid var(--border)",
        padding: "20px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "linear-gradient(180deg, rgba(0,212,170,0.03) 0%, transparent 100%)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "linear-gradient(135deg, var(--accent) 0%, #00a884 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, color: "#0a0e17", fontWeight: 700,
          }}>⛨</div>
          <div>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 18, color: "#fff", letterSpacing: "-0.02em" }}>
              Document Scrubber
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>
              Detect & redact sensitive data from text files
            </div>
          </div>
        </div>
        {phase !== PHASE.UPLOAD && (
          <button onClick={reset} style={{
            background: "var(--surface2)", border: "1px solid var(--border)",
            color: "var(--text-dim)", padding: "7px 16px", borderRadius: 6,
            cursor: "pointer", fontSize: 12, fontFamily: "inherit",
          }}>↺ Start Over</button>
        )}
      </div>

      {/* Phase indicator */}
      <div style={{
        display: "flex", gap: 0, borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
      }}>
        {["Upload Files", "Review & Map", "Download Scrubbed"].map((label, i) => (
          <div key={i} style={{
            flex: 1, padding: "10px 16px", fontSize: 11, fontWeight: 600,
            textAlign: "center", letterSpacing: "0.05em", textTransform: "uppercase",
            color: phase === i ? "var(--accent)" : "var(--text-dim)",
            borderBottom: phase === i ? "2px solid var(--accent)" : "2px solid transparent",
            background: phase === i ? "var(--accent-dim)" : "transparent",
            transition: "all 0.2s",
          }}>
            <span style={{ opacity: phase >= i ? 1 : 0.4 }}>{`0${i + 1}`}</span> {label}
          </div>
        ))}
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>

        {/* ===== PHASE 0: UPLOAD ===== */}
        {phase === PHASE.UPLOAD && (
          <div className="fade-in">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 12, padding: "48px 24px", textAlign: "center",
                cursor: "pointer", transition: "all 0.2s",
                background: dragOver ? "var(--accent-dim)" : "var(--surface)",
              }}
            >
              <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.6 }}>📄</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 600, color: "#fff", marginBottom: 6 }}>
                Drop files here or click to browse
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
                Supports: CSV, TSV, TXT, YML, YAML, JSON, XML, CONF, CFG, INI, LOG, MD, PS1, PY, SH, BAT
              </div>
              <input ref={fileInputRef} type="file" multiple accept=".csv,.tsv,.txt,.yml,.yaml,.json,.xml,.conf,.cfg,.ini,.log,.md,.ps1,.py,.sh,.bat,.cmd"
                style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
            </div>

            {files.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-dim)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  {files.length} file{files.length > 1 ? "s" : ""} loaded
                </div>
                {files.map((f, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 14px", background: "var(--surface)", borderRadius: 8,
                    marginBottom: 6, border: "1px solid var(--border)",
                  }}>
                    <span style={{ fontSize: 13, color: "#fff" }}>{f.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {(f.content.length / 1024).toFixed(1)} KB
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); setFiles(prev => prev.filter((_, j) => j !== i)); }}
                        style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                  </div>
                ))}
                <button onClick={runScan} disabled={scanning} style={{
                  marginTop: 16, width: "100%", padding: "14px",
                  background: scanning ? "var(--surface2)" : "linear-gradient(135deg, var(--accent) 0%, #00a884 100%)",
                  border: "none", borderRadius: 8, color: "#0a0e17",
                  fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15,
                  cursor: scanning ? "wait" : "pointer", letterSpacing: "-0.01em",
                }}>
                  {scanning ? "⟳ Scanning..." : "⛨ Scan for Sensitive Data"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ===== PHASE 1: REVIEW & MAP ===== */}
        {phase === PHASE.REVIEW && (
          <div className="fade-in">
            {/* Stats bar */}
            <div style={{
              display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap",
            }}>
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 20px", flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#fff", fontFamily: "'Space Grotesk', sans-serif" }}>{totalFindings}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>Unique Findings</div>
              </div>
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 20px", flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: "var(--accent)", fontFamily: "'Space Grotesk', sans-serif" }}>{mappedCount}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>Mapped</div>
              </div>
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 20px", flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: totalFindings - mappedCount > 0 ? "var(--warning)" : "var(--accent)", fontFamily: "'Space Grotesk', sans-serif" }}>
                  {totalFindings - mappedCount}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>Unmapped</div>
              </div>
            </div>

            {/* Category tabs */}
            <div style={{
              display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap",
            }}>
              <button onClick={() => setActiveCategory(null)} style={{
                padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)",
                background: !activeCategory ? "var(--accent-dim)" : "var(--surface)",
                color: !activeCategory ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
              }}>All ({totalFindings})</button>
              {Object.entries(CATEGORIES).map(([key, cat]) => (
                <button key={key} onClick={() => setActiveCategory(key)} style={{
                  padding: "6px 14px", borderRadius: 6, border: `1px solid ${activeCategory === key ? cat.color : "var(--border)"}`,
                  background: activeCategory === key ? `${cat.color}15` : "var(--surface)",
                  color: activeCategory === key ? cat.color : "var(--text-dim)",
                  cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 500,
                }}>
                  {cat.icon} {cat.label} ({categoryCounts[key] || 0})
                </button>
              ))}
            </div>

            {/* Action buttons for active category */}
            {activeCategory && (categoryCounts[activeCategory] || 0) > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button onClick={() => autoGenerate(activeCategory)} style={{
                  padding: "6px 14px", borderRadius: 6, border: "1px solid var(--accent)",
                  background: "var(--accent-dim)", color: "var(--accent)",
                  cursor: "pointer", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
                }}>⚡ Auto-generate replacements</button>
                <button onClick={() => clearReplacements(activeCategory)} style={{
                  padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border)",
                  background: "var(--surface)", color: "var(--text-dim)",
                  cursor: "pointer", fontSize: 11, fontFamily: "inherit",
                }}>Clear all</button>
              </div>
            )}

            {/* Filter */}
            <input
              type="text" placeholder="Filter findings..." value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                width: "100%", padding: "10px 14px", marginBottom: 12,
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 8, color: "#fff", fontSize: 13, fontFamily: "inherit",
              }}
            />

            {/* Findings table */}
            <div style={{
              border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden",
              maxHeight: 440, overflowY: "auto",
            }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--surface2)", position: "sticky", top: 0, zIndex: 2 }}>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)", width: "8%" }}>Type</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)", width: "32%" }}>Detected Value</th>
                    <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 11, color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)", width: "8%" }}>Hits</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)", width: "4%" }}>→</th>
                    <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>Replacement Value</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFindings.map(([val, f], i) => (
                    <tr key={val} style={{
                      background: i % 2 === 0 ? "var(--surface)" : "transparent",
                      borderBottom: "1px solid var(--border)",
                    }}>
                      <td style={{ padding: "8px 14px" }}>
                        <span style={{
                          display: "inline-block", padding: "2px 8px", borderRadius: 4,
                          fontSize: 10, fontWeight: 600, letterSpacing: "0.04em",
                          background: `${CATEGORIES[f.category].color}20`,
                          color: CATEGORIES[f.category].color,
                        }}>{CATEGORIES[f.category].icon}</span>
                      </td>
                      <td style={{ padding: "8px 14px", fontSize: 12, color: "#fff", wordBreak: "break-all" }}>
                        {val}
                      </td>
                      <td style={{ padding: "8px 14px", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>
                        {f.count}
                      </td>
                      <td style={{ padding: "8px 14px", color: "var(--accent)", fontSize: 14 }}>→</td>
                      <td style={{ padding: "6px 14px" }}>
                        <input
                          type="text" value={f.replacement}
                          onChange={(e) => updateReplacement(val, e.target.value)}
                          placeholder="Enter replacement..."
                          style={{
                            width: "100%", padding: "7px 10px",
                            background: f.replacement ? "rgba(0,212,170,0.08)" : "var(--surface2)",
                            border: `1px solid ${f.replacement ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: 6, color: f.replacement ? "var(--accent)" : "var(--text-dim)",
                            fontSize: 12, fontFamily: "inherit",
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredFindings.length === 0 && (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                  No findings match this filter
                </div>
              )}
            </div>

            {/* Execute scrub button */}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button onClick={executeScrub} disabled={mappedCount === 0} style={{
                flex: 1, padding: "14px",
                background: mappedCount === 0 ? "var(--surface2)" : "linear-gradient(135deg, var(--accent) 0%, #00a884 100%)",
                border: "none", borderRadius: 8, color: mappedCount === 0 ? "var(--text-dim)" : "#0a0e17",
                fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15,
                cursor: mappedCount === 0 ? "not-allowed" : "pointer",
              }}>
                ⛨ Scrub {files.length} File{files.length > 1 ? "s" : ""} ({mappedCount} replacement{mappedCount !== 1 ? "s" : ""})
              </button>
              <button onClick={downloadMapping} disabled={mappedCount === 0} style={{
                padding: "14px 20px", background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 8, color: "var(--text-dim)", cursor: mappedCount === 0 ? "not-allowed" : "pointer",
                fontSize: 12, fontFamily: "inherit",
              }}>↓ Export Mapping</button>
            </div>
          </div>
        )}

        {/* ===== PHASE 2: DOWNLOAD ===== */}
        {phase === PHASE.SCRUBBED && (
          <div className="fade-in">
            <div style={{
              textAlign: "center", padding: "32px 0 24px",
            }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>✓</div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 700, color: "var(--accent)" }}>
                Scrub Complete
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 6 }}>
                {mappedCount} sensitive value{mappedCount !== 1 ? "s" : ""} replaced across {scrubbedFiles.length} file{scrubbedFiles.length > 1 ? "s" : ""}
              </div>
            </div>

            <div style={{
              border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden",
            }}>
              {scrubbedFiles.map((f, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 18px", borderBottom: i < scrubbedFiles.length - 1 ? "1px solid var(--border)" : "none",
                  background: "var(--surface)",
                }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#fff", fontWeight: 500 }}>{f.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                      {(f.content.length / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button onClick={() => downloadFile(f)} style={{
                    padding: "8px 18px", background: "var(--accent-dim)",
                    border: "1px solid var(--accent)", borderRadius: 6,
                    color: "var(--accent)", cursor: "pointer", fontSize: 12,
                    fontFamily: "inherit", fontWeight: 600,
                  }}>↓ Download</button>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button onClick={downloadAll} style={{
                flex: 1, padding: "14px",
                background: "linear-gradient(135deg, var(--accent) 0%, #00a884 100%)",
                border: "none", borderRadius: 8, color: "#0a0e17",
                fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 14,
                cursor: "pointer",
              }}>↓ Download All Files</button>
              <button onClick={downloadMapping} style={{
                padding: "14px 20px", background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 8, color: "var(--text-dim)", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              }}>↓ Export Mapping CSV</button>
              <button onClick={() => setPhase(PHASE.REVIEW)} style={{
                padding: "14px 20px", background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 8, color: "var(--text-dim)", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              }}>← Edit Mappings</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
