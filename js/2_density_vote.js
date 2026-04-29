function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o");
}

function normalizeCountyName(value) {
  let text = normalizeText(value).replace(/\slan$/, "").trim();

  const manualMap = {
    "stockholms": "stockholm",
    "uppsalas": "uppsala",
    "sodermanlands": "sodermanland",
    "ostergotlands": "ostergotland",
    "jonkopings": "jonkoping",
    "kronobergs": "kronoberg",
    "gotlands": "gotland",
    "hallands": "halland",
    "vastra gotalands": "vastra gotaland",
    "varmlands": "varmland",
    "vastmanlands": "vastmanland",
    "dalarnas": "dalarna",
    "gavleborgs": "gavleborg",
    "vasternorrlands": "vasternorrland",
    "jamtlands": "jamtland",
    "vasterbottens": "vasterbotten",
    "norrbottens": "norrbotten"
  };

  return manualMap[text] || text;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;

  const cleaned = String(value).trim().replace(/\s/g, "").replace(",", ".");
  const num = Number(cleaned);
  return Number.isNaN(num) ? null : num;
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

function average(values) {
  const valid = values.filter(v => typeof v === "number" && !Number.isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function median(values) {
  const valid = values
    .filter(v => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);

  if (!valid.length) return null;

  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0
    ? (valid[mid - 1] + valid[mid]) / 2
    : valid[mid];
}

addMdToPage(`
# Befolkningstäthet och röster
 
Den här sidan undersöker om **befolkningstäthet** hänger ihop med hur människor röstar.
 
I många politiska analyser beskrivs skillnaden mellan **stad och landsbygd** som en viktig skiljelinje.  
Därför tittar vi här på om partiets starkaste kommuner också är kommuner med hög eller låg befolkningstäthet.
 
Vi jämför dessutom partiets starkaste och svagaste kommuner för att få en tydligare bild av om det finns ett geografiskt mönster.
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
  "Socialdemokraterna"
);

try {
  dbQuery.use("counties-sqlite");
  const countyRows = await dbQuery(`
    SELECT lan, invanarePerKm2
    FROM countyInfo
  `);

  dbQuery.use("geo-mysql");
  const geoRows = await dbQuery(`
    SELECT municipality, county
    FROM geoData
  `);

  dbQuery.use("riksdagsval-neo4j");
  const electionRows = await dbQuery(`
    MATCH (n:Partiresultat)
    RETURN n.kommun AS kommun,
           n.parti AS parti,
           n.roster2018 AS roster2018,
           n.roster2022 AS roster2022
  `);

  const densityByCounty = countyRows
    .map(row => ({
      lan: row.lan,
      countyKey: normalizeCountyName(row.lan),
      invanarePerKm2: toNumber(row.invanarePerKm2)
    }))
    .filter(row => row.countyKey && row.invanarePerKm2 !== null);

  const municipalityToCounty = geoRows
    .map(row => ({
      municipalityKey: normalizeText(row.municipality),
      countyKey: normalizeCountyName(row.county)
    }))
    .filter(row => row.municipalityKey && row.countyKey);

  const partyVotes = electionRows
    .map(row => {
      const roster2018 = toNumber(row.roster2018);
      const roster2022 = toNumber(row.roster2022);

      return {
        kommun: row.kommun,
        parti: row.parti,
        roster2018,
        roster2022,
        skillnad:
          roster2018 !== null && roster2022 !== null
            ? roster2022 - roster2018
            : null,
        kommunKey: normalizeText(row.kommun)
      };
    })
    .filter(row => sameParty(row.parti, parti) && row.roster2022 !== null);

  const joined = partyVotes
    .map(voteRow => {
      const geoRow = municipalityToCounty.find(g => g.municipalityKey === voteRow.kommunKey);
      if (!geoRow) return null;

      const densityRow = densityByCounty.find(c => c.countyKey === geoRow.countyKey);
      if (!densityRow) return null;

      return {
        kommun: voteRow.kommun,
        lan: densityRow.lan,
        befolkningstathet: densityRow.invanarePerKm2,
        roster2018: voteRow.roster2018,
        roster2022: voteRow.roster2022,
        skillnad: voteRow.skillnad
      };
    })
    .filter(Boolean);

  const strongest = [...joined]
    .sort((a, b) => b.roster2022 - a.roster2022)
    .slice(0, 10);

  const weakest = [...joined]
    .sort((a, b) => a.roster2022 - b.roster2022)
    .slice(0, 10);

  const denseTop = [...joined]
    .sort((a, b) => b.befolkningstathet - a.befolkningstathet)
    .slice(0, 15);

  const medianDensityStrongest = median(strongest.map(r => r.befolkningstathet));
  const medianDensityWeakest = median(weakest.map(r => r.befolkningstathet));
  const averageChangeStrongest = average(strongest.map(r => r.skillnad));
  const averageChangeWeakest = average(weakest.map(r => r.skillnad));

  addMdToPage(`
## Tolkning
 
Genom att jämföra partiets starkaste och svagaste kommuner kan vi se om stödet verkar vara starkare i tätare eller glesare delar av landet.
 
Om median befolkningstäthet är mycket högre i partiets starkaste kommuner än i dess svagaste kommuner, tyder det på att partiet har en tydlig koppling till mer urbana miljöer.  
Om det är tvärtom pekar det mot en starkare förankring i mindre täta områden.
`);

  addMdToPage(`
**Översikt**
- Matchade kommuner: **${joined.length}**
- Median befolkningstäthet i partiets 10 starkaste kommuner: **${medianDensityStrongest !== null ? medianDensityStrongest.toFixed(1) : "saknas"}**
- Median befolkningstäthet i partiets 10 svagaste kommuner: **${medianDensityWeakest !== null ? medianDensityWeakest.toFixed(1) : "saknas"}**
- Genomsnittlig röstförändring i starkaste kommunerna: **${averageChangeStrongest !== null ? averageChangeStrongest.toFixed(1) : "saknas"}**
- Genomsnittlig röstförändring i svagaste kommunerna: **${averageChangeWeakest !== null ? averageChangeWeakest.toFixed(1) : "saknas"}**
`);

  if (!joined.length) {
    addMdToPage(`
**Ingen sammanslagen data hittades.**
 
Kontrollera att kommunnamnen mellan Neo4j och MySQL matchar.
    `);
  } else {
    addMdToPage(`
## Kommuner med högst befolkningstäthet
 
Här ser vi kommuner med hög befolkningstäthet tillsammans med partiets röster 2018 och 2022.
    `);

    tableFromData({
      data: denseTop.map(r => ({
        "Kommun": r.kommun,
        "Län": r.lan,
        "Invånare per km²": r.befolkningstathet ?? "–",
        "Röster 2018": r.roster2018 ?? "–",
        "Röster 2022": r.roster2022 ?? "–",
        "Skillnad": r.skillnad ?? "–"
      }))
    });

    const scatterRows = joined
      .filter(r => r.befolkningstathet !== null && r.roster2022 !== null)
      .map(r => ({
        befolkningstathet: Number(r.befolkningstathet),
        roster2022: Number(r.roster2022)
      }));

    drawGoogleChart({
      type: "ScatterChart",
      data: makeChartFriendly(scatterRows, "befolkningstathet", "roster2022"),
      options: {
        title: `${parti}: befolkningstäthet och röster 2022`,
        height: 550,
        legend: "none",
        hAxis: { title: "Invånare per km²" },
        vAxis: { title: `Röster på ${parti} 2022` },
        trendlines: { 0: {} }
      }
    });

    const compareRows = [
      {
        grupp: "10 starkaste kommuner",
        mediantathet: medianDensityStrongest !== null ? Number(medianDensityStrongest) : 0
      },
      {
        grupp: "10 svagaste kommuner",
        mediantathet: medianDensityWeakest !== null ? Number(medianDensityWeakest) : 0
      }
    ];

    drawGoogleChart({
      type: "ColumnChart",
      data: makeChartFriendly(compareRows, "grupp", "mediantathet"),
      options: {
        title: `${parti}: median befolkningstäthet i starkaste och svagaste kommunerna`,
        height: 500,
        legend: { position: "none" },
        hAxis: { title: "Grupp" },
        vAxis: { title: "Median invånare per km²" }
      }
    });

    const changeRows = strongest
      .filter(r => r.skillnad !== null)
      .map(r => ({
        kommun: r.kommun,
        skillnad: Number(r.skillnad)
      }));

    drawGoogleChart({
      type: "ColumnChart",
      data: makeChartFriendly(changeRows, "kommun", "skillnad"),
      options: {
        title: `${parti}: förändring mellan 2018 och 2022 i partiets starkaste kommuner`,
        height: 600,
        legend: { position: "none" },
        hAxis: { title: "Kommun", slantedText: true, slantedTextAngle: 45 },
        vAxis: { title: "Skillnad i röster" }
      }
    });
  }
} catch (error) {
  addMdToPage(`## Fel\n**Fel på sidan:** ${error.message}\n\`\`\`\n${error.stack}\n\`\`\``);
}
