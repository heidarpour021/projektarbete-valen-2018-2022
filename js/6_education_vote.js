// utbildning-roster.js
// Undersöker sambandet mellan utbildningsnivå och röster i riksdagsvalen 2018 och 2022.
// Använder de tvättade databaserna utbildningsniva_2018 och utbildningsniva_2022
// med kända kolumnnamn: kommunNamn, antalTotalt, antalEftergymnasialt

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o");
}

function getPartyAliases(selectedParty) {
  const aliases = {
    "Moderaterna": ["Moderaterna"],
    "Socialdemokraterna": ["Socialdemokraterna", "Arbetarepartiet-Socialdemokraterna"],
    "Sverigedemokraterna": ["Sverigedemokraterna"],
    "Centerpartiet": ["Centerpartiet"],
    "Vänsterpartiet": ["Vänsterpartiet"],
    "Kristdemokraterna": ["Kristdemokraterna"],
    "Liberalerna": ["Liberalerna"],
    "Miljöpartiet de gröna": ["Miljöpartiet de gröna"]
  };
  return (aliases[selectedParty] || [selectedParty]).map(normalizeText);
}

function sameParty(dbParty, selectedParty) {
  return getPartyAliases(selectedParty).includes(normalizeText(dbParty));
}

// ── UI ───────────────────────────────────────────────────────────────────────

addMdToPage(`
# Utbildning och röster
 
Undersöker sambandet mellan **andel eftergymnasialt utbildade** i en kommun 
och hur kommunen röstade i riksdagsvalen **2018** och **2022**.
`);

const parti = addDropdown(
  "Välj parti:",
  [
    "Moderaterna",
    "Socialdemokraterna",
    "Sverigedemokraterna",
    "Centerpartiet",
    "Vänsterpartiet",
    "Kristdemokraterna",
    "Liberalerna",
    "Miljöpartiet de gröna"
  ],
  "Moderaterna"
);

const valAr = addDropdown("Välj valår:", ["2022", "2018"], "2022");

try {
  // ── Hämta utbildningsdata ─────────────────────────────────────────────────

  dbQuery.use("utbildning-2018-sqlite");
  const utb2018Rows = await dbQuery(`
    SELECT kommunNamn, antalTotalt, antalEftergymnasialt
    FROM utbildning
  `);

  dbQuery.use("utbildning-2022-sqlite");
  const utb2022Rows = await dbQuery(`
    SELECT kommunNamn, antalTotalt, antalEftergymnasialt
    FROM utbildning
  `);

  // Bygg uppslagskartor: kommunNamn (normaliserat) → { andel (%), antalEftergymnasialt (råtal) }
  const utb2018Map = new Map(
    utb2018Rows.map(r => [
      normalizeText(r.kommunNamn),
      {
        andel: r.antalTotalt > 0 ? (r.antalEftergymnasialt / r.antalTotalt) * 100 : null,
        antalEftergymnasialt: r.antalEftergymnasialt
      }
    ])
  );

  const utb2022Map = new Map(
    utb2022Rows.map(r => [
      normalizeText(r.kommunNamn),
      {
        andel: r.antalTotalt > 0 ? (r.antalEftergymnasialt / r.antalTotalt) * 100 : null,
        antalEftergymnasialt: r.antalEftergymnasialt
      }
    ])
  );

  // ── Hämta valdata ─────────────────────────────────────────────────────────

  dbQuery.use("riksdagsval-neo4j");
  const electionRows = await dbQuery(`
    MATCH (n:Partiresultat)
    RETURN n.kommun AS kommun,
           n.parti  AS parti,
           n.roster2018 AS roster2018,
           n.roster2022 AS roster2022
  `);

  // ── Slå ihop datakällorna ─────────────────────────────────────────────────

  const valtAr = Number(valAr);
  const rosterKey = valtAr === 2022 ? "roster2022" : "roster2018";
  const utbMap = valtAr === 2022 ? utb2022Map : utb2018Map;

  const joined = electionRows
    .filter(r => sameParty(r.parti, parti) && r[rosterKey] !== null)
    .map(r => {
      const key = normalizeText(r.kommun);
      const utbData = utbMap.get(key) ?? null;
      if (!utbData || utbData.andel === null) return null;
      return {
        kommun: r.kommun,
        // Råtal röster (används i tabeller)
        antalRoster: Number(r[rosterKey]),
        // Råtal eftergymnasialt utbildade (används i tabeller)
        antalEftergymnasialt: utbData.antalEftergymnasialt,
        // Procentvärden behålls ENDAST för scatter-diagram och korrelation
        rosterProcent: Number(r[rosterKey]),
        andelEftergymnasialt: parseFloat(utbData.andel.toFixed(1))
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.andelEftergymnasialt - a.andelEftergymnasialt);

  // ── Statistik ─────────────────────────────────────────────────────────────

  const utbVals = joined.map(r => r.andelEftergymnasialt);
  const rosterVals = joined.map(r => r.rosterProcent);
  const korr = s.sampleCorrelation(utbVals, rosterVals);

  const riktning = korr > 0
    ? "positiv – fler högskoleutbildade → fler röster"
    : "negativ – fler högskoleutbildade → färre röster";

  const styrka = Math.abs(korr) < 0.1 ? "försumbar"
    : Math.abs(korr) < 0.3 ? "svag"
      : Math.abs(korr) < 0.5 ? "måttlig"
        : "stark";

  // ── Visa resultat ─────────────────────────────────────────────────────────

  addMdToPage(`
## ${parti} – ${valtAr}
 
**Matchade kommuner:** ${joined.length}  
**Korrelation (Pearson r):** ${korr.toFixed(3)} – *${styrka} ${riktning}*
`);

  // Scatter med trendlinje (använder fortfarande procentvärden för diagrammet)
  drawGoogleChart({
    type: "ScatterChart",
    data: makeChartFriendly(
      joined.map(r => ({
        eftergymnasial: r.andelEftergymnasialt,
        roster: r.rosterProcent
      })),
      `Andel eftergymnasial utbildning ${valtAr} (%)`,
      `Röster på ${parti} ${valtAr} (%)`
    ),
    options: {
      title: `${parti} ${valtAr}: utbildningsnivå vs röstandel per kommun`,
      height: 520,
      legend: "none",
      chartArea: { left: 70, right: 20 },
      hAxis: { title: `Andel eftergymnasial utbildning ${valtAr} (%)` },
      vAxis: { title: `Röster på ${parti} ${valtAr} (%)` },
      trendlines: { 0: { showR2: true, visibleInLegend: true } }
    }
  });

  // Topp 15 kommuner per utbildningsnivå – visar RAW-TAL
  addMdToPage(`### Topp 15 kommuner – högst utbildningsnivå ${valtAr}`);
  tableFromData({
    data: joined.slice(0, 15).map(r => ({
      "Kommun": r.kommun,
      [`Antal röster ${valtAr}`]: r.antalRoster,
      [`Antal eftergymnasialt utbildade ${valtAr}`]: r.antalEftergymnasialt
    }))
  });

  // Botten 15 – visar RAW-TAL
  addMdToPage(`### Botten 15 kommuner – lägst utbildningsnivå ${valtAr}`);
  tableFromData({
    data: [...joined].reverse().slice(0, 15).map(r => ({
      "Kommun": r.kommun,
      [`Antal röster ${valtAr}`]: r.antalRoster,
      [`Antal eftergymnasialt utbildade ${valtAr}`]: r.antalEftergymnasialt
    }))
  });

  // Jämförelse 2018 vs 2022 om båda valda
  addMdToPage(`
## Jämförelse: utbildningsnivå 2018 vs 2022
 
Ser vi någon förändring i sambandet mellan de två valen?
`);

  // Bygg joined för båda åren – RAW-TAL sparas
  const joinedBada = electionRows
    .filter(r => sameParty(r.parti, parti) && r.roster2018 !== null && r.roster2022 !== null)
    .map(r => {
      const key = normalizeText(r.kommun);
      const utbData18 = utb2018Map.get(key) ?? null;
      const utbData22 = utb2022Map.get(key) ?? null;
      if (!utbData18 || utbData18.andel === null) return null;
      if (!utbData22 || utbData22.andel === null) return null;
      return {
        kommun: r.kommun,
        // Råtal röster
        antalRoster2018: Number(r.roster2018),
        antalRoster2022: Number(r.roster2022),
        // Råtal utbildade
        antalEftergymnasialt2018: utbData18.antalEftergymnasialt,
        antalEftergymnasialt2022: utbData22.antalEftergymnasialt,
        // Procentvärden för diagram och korrelation
        roster2018: Number(r.roster2018),
        roster2022: Number(r.roster2022),
        utb2018: parseFloat(utbData18.andel.toFixed(1)),
        utb2022: parseFloat(utbData22.andel.toFixed(1)),
        utbForandring: parseFloat((utbData22.andel - utbData18.andel).toFixed(2)),
        rosterForandring: parseFloat((Number(r.roster2022) - Number(r.roster2018)).toFixed(2))
      };
    })
    .filter(Boolean);

  const korr18 = s.sampleCorrelation(joinedBada.map(r => r.utb2018), joinedBada.map(r => r.roster2018));
  const korr22 = s.sampleCorrelation(joinedBada.map(r => r.utb2022), joinedBada.map(r => r.roster2022));

  tableFromData({
    data: [
      { "Valår": "2018", "Korrelation (r)": korr18.toFixed(3), "Antal kommuner": joinedBada.length },
      { "Valår": "2022", "Korrelation (r)": korr22.toFixed(3), "Antal kommuner": joinedBada.length }
    ]
  });

  drawGoogleChart({
    type: "ScatterChart",
    data: [
      ["Utbildning 2018 (%)", `Röster ${parti} 2018 (%)`, "Utbildning 2022 (%)", `Röster ${parti} 2022 (%)`],
      ...joinedBada.map(r => [r.utb2018, r.roster2018, r.utb2022, r.roster2022])
    ],
    options: {
      title: `${parti}: utbildning vs röster – 2018 (blå) och 2022 (röd)`,
      height: 500,
      chartArea: { left: 70, right: 20 },
      series: {
        0: { color: "#4e79a7" },
        1: { color: "#e05252" }
      },
      hAxis: { title: "Andel eftergymnasial utbildning (%)" },
      vAxis: { title: `Röster på ${parti} (%)` },
      trendlines: {
        0: { color: "#4e79a7" },
        1: { color: "#e05252" }
      }
    }
  });

} catch (error) {
  addMdToPage(`## Fel\n\`${error.message}\``);
}
