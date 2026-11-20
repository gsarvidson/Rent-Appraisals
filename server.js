'use strict';
const express = require('express');
const https   = require('https');
const crypto  = require('crypto');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ──────────────────────────────────────────────────────────────────
const CONSUMER_KEY    = process.env.TM_CONSUMER_KEY    || '82FC54CD50EE1EB64D741EDE5D5164E6';
const CONSUMER_SECRET = process.env.TM_CONSUMER_SECRET || '055798AC61CAB2391DE08636458DDE5A';
const TM_API_BASE     = 'https://api.trademe.co.nz/v1';
const PBI_DATASET_ID  = '2c1b72b6-7b69-4378-81c7-e329c1974064'; // OneHub Rental Market Insights

// ─── OAuth 1.0a ──────────────────────────────────────────────────────────────
function pct(s) { return encodeURIComponent(String(s)); }

function oauthHeader(method, baseUrl, queryParams = {}) {
  const ts    = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const oauth = {
    oauth_consumer_key:     CONSUMER_KEY,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_version:          '1.0',
  };

  const all    = { ...oauth, ...queryParams };
  const sorted = Object.keys(all).sort().map(k => `${pct(k)}=${pct(all[k])}`).join('&');
  const base   = `${method}&${pct(baseUrl)}&${pct(sorted)}`;
  const sigKey = `${pct(CONSUMER_SECRET)}&`;
  const sig    = crypto.createHmac('sha1', sigKey).update(base).digest('base64');

  oauth.oauth_signature = sig;
  return 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}

// ─── TM API helper ────────────────────────────────────────────────────────────
async function tmGet(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const baseUrl = `${TM_API_BASE}${endpoint}`;
    const auth    = oauthHeader('GET', baseUrl, params);
    const qs      = Object.entries(params).map(([k, v]) => `${k}=${pct(v)}`).join('&');
    const fullUrl = qs ? `${baseUrl}?${qs}` : baseUrl;

    const req = https.get(fullUrl, {
      headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': 'TM-Rent-Appraisal/1.0' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`TM API ${res.statusCode}: ${body.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}. Body: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
  });
}

// ─── PBI helper ───────────────────────────────────────────────────────────────
async function pbiQuery(token, dax, datasetId = PBI_DATASET_ID) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true },
    });
    const req = https.request({
      hostname: 'api.powerbi.com',
      path:     `/v1.0/myorg/datasets/${datasetId}/executeQueries`,
      method:   'POST',
      headers:  {
        Authorization:   `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('PBI response parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractId(input = '') {
  // Try /listing/DIGITS first
  const m = input.match(/\/listing\/(\d+)/i);
  if (m) return m[1];
  // Fall back to last all-digit path segment in the URL
  const segments = input.split(/[/?#]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^\d{6,}$/.test(segments[i])) return segments[i];
  }
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

function getRent(l) {
  if (l.RentPerWeek > 0) return l.RentPerWeek;
  if (l.StartPrice   > 0) return l.StartPrice;
  const m = String(l.PriceDisplay || '').match(/\$([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
}

// Photos: TM API returns Photos[n].Value.Gallery (or Large/FullSize)
function getPhoto(l) {
  // Search results use PictureHref; full listings use Photos[n].Value.*
  if (l.PictureHref) return l.PictureHref;
  const photos = l.Photos || [];
  if (!photos.length) return null;
  const v = photos[0].Value;
  if (v) return v.Gallery || v.Large || v.FullSize || v.Medium || v.Thumbnail;
  return null;
}

function getPhotos(l) {
  return (l.Photos || [])
    .map(p => {
      if (!p.Value) return null;
      const v = p.Value;
      return {
        full:  v.FullSize || v.Large || v.Gallery || v.Medium || v.Thumbnail,
        thumb: v.Gallery  || v.Medium || v.Large  || v.Thumbnail,
      };
    })
    .filter(p => p && p.full);
}

// Attributes array lookup: [{Name, Value}, ...]
function getAttrMap(listing) {
  const map = {};
  for (const a of (listing.Attributes || [])) {
    if (a.Name && !map[a.Name]) map[a.Name] = a.Value;
  }
  return map;
}

function parseNum(str) {
  if (typeof str === 'number') return str;
  const m = String(str || '').match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function propTypeName(t) {
  if (typeof t === 'string' && t.length > 1) return t;
  const m = { 1:'House', 2:'Apartment', 3:'Unit', 4:'Townhouse', 5:'Section', 6:'Other' };
  return m[t] || 'Property';
}

// ─── Rent estimate from comparables ──────────────────────────────────────────
function calcEstimate(listings) {
  const rents = listings.map(getRent).filter(r => r >= 100 && r <= 10000).sort((a, b) => a - b);
  if (!rents.length) return null;

  const n   = rents.length;
  const q   = p => rents[Math.min(Math.floor(n * p), n - 1)];
  const med = n % 2 === 0 ? (rents[n/2-1] + rents[n/2]) / 2 : rents[Math.floor(n/2)];
  const r10 = x => Math.round(x / 10) * 10;

  const confidence = n >= 10 ? 'High' : n >= 5 ? 'Medium' : 'Low';
  const score      = n >= 10 ? Math.min(72 + n * 1.5, 93) : n >= 5 ? 48 + n * 3 : 20 + n * 4;

  return {
    low:             r10(q(0.25)),
    high:            r10(q(0.75)),
    median:          r10(med),
    annualised:      r10(med) * 52,
    confidence,
    confidenceScore: Math.round(score),
    sampleSize:      n,
  };
}

// ─── Derive bond data from wider comps ───────────────────────────────────────
function deriveBondData(listings, targetBeds) {
  // Group by bedrooms
  const groups = {};
  for (const l of listings) {
    const beds = Number(l.Bedrooms) || 0;
    if (!beds) continue;
    const r = getRent(l);
    if (r < 100) continue;
    if (!groups[beds]) groups[beds] = [];
    groups[beds].push(r);
  }

  const result = [];
  const bedsToShow = [...new Set([1, 2, 3, 4, ...Object.keys(groups).map(Number)])].sort();

  for (const beds of bedsToShow) {
    const rents = (groups[beds] || []).sort((a, b) => a - b);
    const n     = rents.length;
    if (!n) {
      result.push({ beds, q1: null, median: null, q3: null, n: 0, isTarget: beds === targetBeds });
      continue;
    }
    const q = p => rents[Math.min(Math.floor(n * p), n - 1)];
    const m = n % 2 === 0 ? (rents[n/2-1] + rents[n/2]) / 2 : rents[Math.floor(n/2)];
    result.push({
      beds,
      q1:       Math.round(q(0.25)),
      median:   Math.round(m),
      q3:       Math.round(q(0.75)),
      n,
      isTarget: beds === targetBeds,
    });
  }
  return result.slice(0, 5); // max 5 rows
}

// ─── Generate intelligence text ──────────────────────────────────────────────
function generateIntelligence(listing, estimate, comparables) {
  if (!estimate) return 'Insufficient comparable data to generate market intelligence.';

  const typeName = propTypeName(listing.PropertyType);
  const beds     = listing.Bedrooms || 3;
  const suburb   = listing.Suburb || 'this area';
  const district = listing.District || '';
  const n        = estimate.sampleSize;
  const med      = estimate.median;
  const low      = estimate.low;
  const high     = estimate.high;
  const range    = high - low;
  const market   = range <= 50 ? 'tight' : range <= 100 ? 'moderately variable' : 'broad';

  const listingText = n === 1 ? '1 comparable listing' : `${n} comparable listings`;

  return `This ${beds}-bed ${typeName.toLowerCase()} in ${suburb} sits in a ${market} rental market. ` +
    `Analysis of ${listingText} in ${district || suburb} shows a median of $${med.toLocaleString()}/wk. ` +
    `Listing at $${low.toLocaleString()}–$${high.toLocaleString()}/wk should attract quality tenants` +
    (estimate.confidence === 'High' ? ' within 2–3 weeks based on current search demand.' :
     estimate.confidence === 'Medium' ? ' within 3–4 weeks.' : ' — limited comparable data available.');
}

// ─── Debug endpoint — returns raw TM API response ────────────────────────────
app.get('/api/debug/:id', async (req, res) => {
  try {
    const listing = await tmGet(`/Listings/${req.params.id}.json`);
    res.json(listing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Main appraisal endpoint ──────────────────────────────────────────────────
app.get('/api/appraise', async (req, res) => {
  try {
    const id = extractId(req.query.url || req.query.id || '');
    if (!id) return res.status(400).json({ error: 'Invalid or missing Trade Me listing URL' });

    // 1. Fetch the for-sale listing details
    const listing = await tmGet(`/Listings/${id}.json`);
    const attrs   = getAttrMap(listing);

    // Extract from Attributes array (the real source of truth for property listings)
    const address    = attrs['location'] || listing.Title;
    const suburb     = attrs['suburb']   || listing.Suburb || '';
    const district   = attrs['district'] || '';
    const beds       = parseNum(attrs['bedrooms']) || 3;
    const baths      = parseNum(attrs['bathrooms']);
    const propType   = attrs['property_type'] || '';
    const floorArea  = attrs['floor_area'];
    const landArea   = attrs['land_area'];
    const parking    = attrs['parking'] || attrs['garage_parking'];
    const lat        = listing.GeographicLocation?.Latitude;
    const lng        = listing.GeographicLocation?.Longitude;
    const suburbId   = listing.SuburbId;
    const districtId = listing.DistrictId;

    console.log(`[appraise] ${address} | ${beds} bed | suburb:${suburb}(${suburbId}) | district:${district}(${districtId})`);

    // Map TM property type string → rental search property_type code
    const propTypeCode = { 'House':1, 'Apartment':2, 'Unit':3, 'Townhouse':4, 'Studio':5 };
    const subjectType  = propType || propTypeName(listing.PropertyType);
    const typeCode     = propTypeCode[subjectType] || null;

    const merge = (pool, extra) => {
      const seen = new Set(pool.map(c => c.ListingId));
      return [...pool, ...extra.filter(c => !seen.has(c.ListingId))];
    };

    // Score a rental listing by similarity to subject property (higher = more similar)
    function score(c) {
      let s = 0;
      const cBeds  = Number(c.Bedrooms)  || 0;
      const cBaths = Number(c.Bathrooms) || 0;
      // Exact suburb match is the strongest signal
      if (c.SuburbId && (c.SuburbId === rentalSuburbId || c.SuburbId === suburbId)) s += 50;
      else if (c.Suburb && c.Suburb.toLowerCase().includes(suburb.toLowerCase())) s += 50;
      // Exact bed match
      if (cBeds === beds)              s += 30;
      else if (Math.abs(cBeds - beds) === 1) s += 10;
      // Bath match
      if (baths && cBaths === baths)   s += 15;
      else if (baths && Math.abs(cBaths - baths) <= 1) s += 5;
      // Property type
      if (typeCode && c.PropertyType === typeCode) s += 10;
      return s;
    }

    // ── Fetch pool ────────────────────────────────────────────────────────────
    // Strategy: use suburb NAME as primary search (more reliable than the for-sale SuburbId).
    // Discover the rental SuburbId from search results, then widen progressively.
    let pool = [];
    let rentalSuburbId = null; // resolved from actual rental search results

    const exactBeds  = { bedrooms_min: beds,                bedrooms_max: beds };
    const looseBeds  = { bedrooms_min: Math.max(1, beds-1), bedrooms_max: beds+1 };
    const exactBaths = baths ? { bathrooms_min: baths, bathrooms_max: baths } : {};
    const looseBaths = baths ? { bathrooms_min: Math.max(1, baths-1), bathrooms_max: baths+1 } : {};

    // ── Step 1: resolve the correct rental SuburbId via name search ───────────
    if (suburb) {
      const r = await tmGet('/Search/Property/Rental.json', { rows: 10, search_string: suburb, ...exactBeds });
      const hits = (r.List || r.Listings || []).filter(c =>
        c.Suburb && c.Suburb.toLowerCase().includes(suburb.toLowerCase())
      );
      if (hits.length) rentalSuburbId = hits[0].SuburbId;
      console.log(`[appraise] resolved rentalSuburbId=${rentalSuburbId} via name search`);
    }
    if (!rentalSuburbId) rentalSuburbId = suburbId;

    // ── Step 2: progressive search passes ────────────────────────────────────
    // Pass 1: suburb + adjacent + exact beds + exact baths (tightest)
    if (rentalSuburbId) {
      const r = await tmGet('/Search/Property/Rental.json', {
        rows: 50, suburb: rentalSuburbId, adjacent_suburbs: true, ...exactBeds, ...exactBaths,
      });
      pool = merge(pool, r.List || r.Listings || []);
      console.log(`[appraise] pass1 suburb+adj+exactbeds+exactbaths: ${pool.length}`);
    }

    // Pass 2: suburb + adjacent + exact beds + loose baths
    if (pool.length < 8 && rentalSuburbId) {
      const r = await tmGet('/Search/Property/Rental.json', {
        rows: 50, suburb: rentalSuburbId, adjacent_suburbs: true, ...exactBeds, ...looseBaths,
      });
      pool = merge(pool, r.List || r.Listings || []);
      console.log(`[appraise] pass2 suburb+adj+exactbeds+loosebaths: ${pool.length}`);
    }

    // Pass 3: suburb + adjacent + loose beds + exact baths
    if (pool.length < 8 && rentalSuburbId) {
      const r = await tmGet('/Search/Property/Rental.json', {
        rows: 50, suburb: rentalSuburbId, adjacent_suburbs: true, ...looseBeds, ...exactBaths,
      });
      pool = merge(pool, r.List || r.Listings || []);
      console.log(`[appraise] pass3 suburb+adj+loosebeds+exactbaths: ${pool.length}`);
    }

    // Pass 4: suburb + adjacent + loose beds + loose baths
    if (pool.length < 8 && rentalSuburbId) {
      const r = await tmGet('/Search/Property/Rental.json', {
        rows: 50, suburb: rentalSuburbId, adjacent_suburbs: true, ...looseBeds, ...looseBaths,
      });
      pool = merge(pool, r.List || r.Listings || []);
      console.log(`[appraise] pass4 suburb+adj+loosebeds+loosebaths: ${pool.length}`);
    }

    // Pass 5: district + exact beds + exact baths (last resort, broader area)
    if (pool.length < 8 && districtId) {
      const r = await tmGet('/Search/Property/Rental.json', {
        rows: 50, district: districtId, ...exactBeds, ...exactBaths,
      });
      pool = merge(pool, r.List || r.Listings || []);
      console.log(`[appraise] pass5 district+exactbeds+exactbaths: ${pool.length}`);
    }

    // ── Rank by similarity, take top 8 ───────────────────────────────────────
    const comparables = pool
      .map(c => ({ ...c, _score: score(c) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);

    // Wider set (all bedrooms in district) for bond data table only
    let widerComps = pool;
    if (districtId && pool.length < 20) {
      const wr = await tmGet('/Search/Property/Rental.json', { district: districtId, rows: 50 });
      widerComps = merge(pool, wr.List || wr.Listings || []);
    }

    // 3. Calculate outputs
    const estimate    = calcEstimate(comparables);
    const bondData    = deriveBondData(widerComps, beds);
    const intelligence = generateIntelligence(listing, estimate, comparables);

    // 4. Market signals from TM data
    const daysListed = comparables
      .map(c => { const d = c.DateListed || c.StartDate || c.ListedDate; return d ? Math.floor((Date.now() - new Date(d)) / 86400000) : null; })
      .filter(d => d !== null && d >= 0 && d < 180);
    const avgDays = daysListed.length
      ? Math.round(daysListed.reduce((a,b) => a+b, 0) / daysListed.length)
      : null;

    // 5. Format response
    res.json({
      listing: {
        id,
        title:        listing.Title,
        address,
        suburb,
        suburbId,
        district,
        districtId,
        region:       listing.Region || attrs['region'],
        bedrooms:     beds,
        bathrooms:    baths,
        parking,
        propertyType: propType || propTypeName(listing.PropertyType),
        floorArea,
        landArea,
        yearBuilt:    listing.YearBuilt,
        lat,
        lng,
        photos:       getPhotos(listing),
      },
      estimate,
      intelligence,
      searchScope: {
        suburb:   suburb   || null,
        district: district || null,
        beds,
        poolSize: pool.length,
        shown:    comparables.length,
      },
      comparables: comparables.slice(0, 12).map(c => ({
        id:           c.ListingId,
        title:        c.Title,
        address:      c.Address,
        suburb:       c.Suburb,
        bedrooms:     c.Bedrooms,
        bathrooms:    c.Bathrooms,
        propertyType: propTypeName(c.PropertyType),
        rentPerWeek:  getRent(c),
        daysListed:   (() => {
          const raw = c.StartDate || c.DateListed || c.ListedDate;
          if (!raw) return null;
          // TM dates come as /Date(1234567890000)/ or ISO strings
          let ms;
          const dotnet = String(raw).match(/\/Date\((\d+)\)\//);
          if (dotnet) ms = parseInt(dotnet[1]);
          else ms = new Date(raw).getTime();
          if (isNaN(ms)) return null;
          const days = Math.floor((Date.now() - ms) / 86400000);
          return days >= 0 ? days : null;
        })(),
        photo:        getPhoto(c),
        lat:          c.GeographicLocation?.Latitude  || null,
        lng:          c.GeographicLocation?.Longitude || null,
        url:          `https://www.trademe.co.nz/a/property/residential/rent/listing/${c.ListingId}`,
      })),
      bondData,
      marketSignals: {
        activeSimilarListings: comparables.length,
        avgDaysListed:         avgDays,
        suburbName:            listing.Suburb,
        districtName:          listing.District,
      },
    });

  } catch (err) {
    console.error('[appraise] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PBI market data endpoint ─────────────────────────────────────────────────
// Fetches median rent trend + market signals from Power BI "OneHub Rental Market Insights"
// User supplies their own Bearer token (get from browser DevTools → api.powerbi.com requests)
app.post('/api/pbi-market', async (req, res) => {
  try {
    const { token, suburb, district, bedrooms } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing Power BI bearer token' });

    const distFilter  = `'dim location'[district] = "${district}"`;
    const bedFilter   = `'dim bedrooms'[Bedrooms] = ${bedrooms}`;
    const dateFilter  = (col) => `${col} >= FORMAT ( EDATE ( TODAY (), -13 ), "YYYY-MM-DD" )`;

    // Query 1: monthly median rent trend (fact price)
    const daxRent = `
EVALUATE
FILTER (
  SUMMARIZECOLUMNS (
    'fact price'[Month], 'dim location'[district], 'dim bedrooms'[Bedrooms],
    "MedianRent", MEDIAN ( 'fact price'[EstimatedListingValue] )
  ),
  'dim location'[district] = "${district}" && 'dim bedrooms'[Bedrooms] = ${bedrooms}
    && 'fact price'[Month] >= DATE(${new Date().getFullYear() - 1}, ${new Date().getMonth() + 1}, 1)
)
ORDER BY 'fact price'[Month] ASC`.trim();

    // Query 2: monthly avg days on site + listings started (fact listing ended + started)
    const daxDays = `
EVALUATE
FILTER (
  SUMMARIZECOLUMNS (
    'fact listing ended'[Month], 'dim location'[district], 'dim bedrooms'[Bedrooms],
    "AvgDaysOnSite",   AVERAGE ( 'fact listing ended'[DaysOnSite] ),
    "ListingsEnded",   COUNTROWS ( 'fact listing ended' ),
    "ListingsStarted", CALCULATE ( COUNTROWS ( 'fact listing started' ) )
  ),
  'dim location'[district] = "${district}" && 'dim bedrooms'[Bedrooms] = ${bedrooms}
    && 'fact listing ended'[Month] >= DATE(${new Date().getFullYear() - 1}, ${new Date().getMonth() + 1}, 1)
)
ORDER BY 'fact listing ended'[Month] ASC`.trim();

    // Query 3: watchlisters (demand snapshot) + latest listings started
    const daxDemand = `
EVALUATE
FILTER (
  SUMMARIZECOLUMNS (
    'dim location'[district], 'dim bedrooms'[Bedrooms],
    "Watchlisters",    SUM ( 'fact watchlisters'[UniqueMembers] ),
    "ListingsStarted", CALCULATE ( COUNTROWS ( 'fact listing started' ) )
  ),
  'dim location'[district] = "${district}" && 'dim bedrooms'[Bedrooms] = ${bedrooms}
)`.trim();

    // Run all three in parallel
    const [rentResult, daysResult, demandResult] = await Promise.all([
      pbiQuery(token, daxRent),
      pbiQuery(token, daxDays),
      pbiQuery(token, daxDemand),
    ]);

    const getRows = r => r?.results?.[0]?.tables?.[0]?.rows || [];
    const pick    = (r, ...keys) => { for (const k of keys) if (r[k] !== undefined) return r[k]; return null; };

    // Rent trend
    const rentRows = getRows(rentResult);
    const rentTrend = rentRows.map(r => ({
      month:      pick(r, '[Month]', 'fact price[Month]'),
      medianRent: pick(r, '[MedianRent]', 'fact price[MedianRent]'),
    }));

    // Days on site trend
    const daysRows = getRows(daysResult);
    const daysTrend = daysRows.map(r => ({
      month:          pick(r, '[Month]', 'fact listing ended[Month]'),
      avgDaysOnSite:  pick(r, '[AvgDaysOnSite]', 'fact listing ended[AvgDaysOnSite]'),
      listingsEnded:  pick(r, '[ListingsEnded]', 'fact listing ended[ListingsEnded]'),
      listingsStarted: pick(r, '[ListingsStarted]', 'fact listing started[ListingsStarted]'),
    }));

    // Demand: watchlisters per listing
    const demandRow   = getRows(demandResult)[0] || {};
    const watchlisters  = pick(demandRow, '[Watchlisters]', 'fact watchlisters[Watchlisters]') || 0;
    const listStarted   = pick(demandRow, '[ListingsStarted]', 'fact listing started[ListingsStarted]') || 1;
    const watchlistersPerListing = listStarted > 0 ? Math.round(watchlisters / listStarted) : null;

    // Latest avg days on site
    const latestDays = daysRows.length ? daysRows[daysRows.length - 1] : null;
    const avgDaysOnSite = latestDays ? Math.round(pick(latestDays, '[AvgDaysOnSite]', 'fact listing ended[AvgDaysOnSite]')) : null;

    // YoY rent change
    let yoyChange = null;
    if (rentTrend.length >= 2) {
      const latest  = rentTrend[rentTrend.length - 1]?.medianRent;
      const yearAgo = rentTrend[0]?.medianRent;
      if (latest && yearAgo) yoyChange = Math.round(((latest - yearAgo) / yearAgo) * 100 * 10) / 10;
    }

    res.json({
      trend: rentTrend,
      daysTrend,
      avgDaysOnSite,
      watchlistersPerListing,
      watchlisters,
      listingsStarted: listStarted,
      yoyChange,
    });

  } catch (err) {
    console.error('[pbi-market] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🏠  Rent Appraisal Tool  →  http://localhost:${PORT}\n`);
  console.log(`  Paste any Trade Me for-sale listing URL to get a rental estimate.\n`);
});
