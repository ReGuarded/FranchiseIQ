// FranchiseIQ v1.2 — API handler
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { type } = body;

    // ── RESEARCH PIPELINE ──
    if (type === 'research') {
      const { address } = body;
      const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
      if (!GOOGLE_KEY) return res.status(200).json({ error: 'Google Maps API key not configured' });

      // Geocode address
      const geoRes = await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + GOOGLE_KEY);
      const geoData = await geoRes.json();
      if (!geoData.results || geoData.results.length === 0) return res.status(200).json({ error: 'Address not found' });

      const lat = geoData.results[0].geometry.location.lat;
      const lng = geoData.results[0].geometry.location.lng;
      const formattedAddress = geoData.results[0].formatted_address;

      // Extract zip code
      var zipCode = null;
      var comps = geoData.results[0].address_components || [];
      for (var i = 0; i < comps.length; i++) {
        if (comps[i].types.indexOf('postal_code') !== -1) { zipCode = comps[i].long_name; break; }
      }

      // Distance helper
      function distMiles(lat1, lng1, lat2, lng2) {
        if (!lat1 || !lng1 || !lat2 || !lng2) return null;
        var R = 3958.8;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLng = (lng2 - lng1) * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
        return Math.round(3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
      }

      function fmtDist(m) {
        if (m === null) return null;
        if (m < 0.1) return 'Same block';
        if (m < 0.3) return 'Walking distance (' + m + ' mi)';
        return m + ' miles away';
      }

      // Census lookup
      async function getCensus(zip) {
        if (!zip) return null;
        try {
          var url = 'https://api.census.gov/data/2022/acs/acs5?get=B01003_001E,B25003_003E,B25003_001E,B19013_001E,B25064_001E,B01002_001E,B25035_001E&for=zip%20code%20tabulation%20area:' + zip;
          var r = await (await fetch(url)).json();
          if (!r || r.length < 2) return null;
          var h = r[0]; var v = r[1];
          function g(n) { var i = h.indexOf(n); return i === -1 ? null : (parseInt(v[i]) < 0 ? null : parseInt(v[i])); }
          var tot = g('B25003_001E'); var ren = g('B25003_003E'); var yr = g('B25035_001E');
          return {
            zip: zip,
            totalPopulation: g('B01003_001E'),
            renterPercentage: (ren && tot) ? Math.round(ren/tot*100) : null,
            medianHouseholdIncome: g('B19013_001E') ? '$' + g('B19013_001E').toLocaleString() : null,
            medianGrossRent: g('B25064_001E') ? '$' + g('B25064_001E').toLocaleString() : null,
            medianAge: g('B01002_001E'),
            housingEra: yr ? (yr < 1980 ? '1960s-1970s (older stock, fewer in-unit hookups)' : yr < 1995 ? '1980s-1990s (mixed-age stock)' : '1990s-2000s (newer stock)') : null
          };
        } catch(e) { return null; }
      }

      // Owner profile lookup
      async function getOwnerProfile() {
        try {
          var url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' + lat + ',' + lng + '&radius=100&keyword=laundromat+laundry&key=' + GOOGLE_KEY;
          var nearby = await (await fetch(url)).json();
          if (!nearby.results || nearby.results.length === 0) return null;
          var place = nearby.results[0];
          var detUrl = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + place.place_id + '&fields=name,rating,user_ratings_total,reviews,formatted_phone_number,website&key=' + GOOGLE_KEY;
          var det = await (await fetch(detUrl)).json();
          var d = det.result || {};
          var reviews = (d.reviews || []).slice(0, 5).map(function(r) {
            return { rating: r.rating, text: (r.text || '').substring(0, 250) };
          }).filter(function(r) { return r.text.length > 10; });
          return { name: d.name || place.name, rating: d.rating || place.rating, reviewCount: d.user_ratings_total || place.user_ratings_total || 0, phone: d.formatted_phone_number || null, reviews: reviews };
        } catch(e) { return null; }
      }

      // FULL search — fetches Places Details + reviews (used for competitors and apartments)
      async function searchFull(query, radius, maxN, presort) {
        try {
          var url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' + lat + ',' + lng + '&radius=' + radius + '&keyword=' + encodeURIComponent(query) + '&key=' + GOOGLE_KEY;
          var data = await (await fetch(url)).json();
          if (!data.results || data.results.length === 0) return [];
          var candidates = data.results;
          if (presort) {
            candidates = candidates.map(function(p) {
              var pLat = p.geometry ? p.geometry.location.lat : null;
              var pLng = p.geometry ? p.geometry.location.lng : null;
              return { place: p, d: distMiles(lat, lng, pLat, pLng) };
            }).sort(function(a, b) {
              return (a.d !== null ? a.d : 999) - (b.d !== null ? b.d : 999);
            }).map(function(c) { return c.place; });
          }
          var topN = candidates.slice(0, maxN);
          var detailed = await Promise.all(topN.map(async function(place) {
            try {
              var dUrl = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + place.place_id + '&fields=name,formatted_address,formatted_phone_number,rating,user_ratings_total,geometry,reviews&key=' + GOOGLE_KEY;
              var det = await (await fetch(dUrl)).json();
              var d = det.result || {};
              var pLat = d.geometry ? d.geometry.location.lat : (place.geometry ? place.geometry.location.lat : null);
              var pLng = d.geometry ? d.geometry.location.lng : (place.geometry ? place.geometry.location.lng : null);
              var dm = distMiles(lat, lng, pLat, pLng);
              var reviews = (d.reviews || []).slice(0, 3).map(function(r) {
                return { rating: r.rating, text: (r.text || '').substring(0, 300) };
              }).filter(function(r) { return r.text.length > 20; });
              return { name: d.name || place.name, address: d.formatted_address || place.vicinity, phone: d.formatted_phone_number || null, rating: d.rating || place.rating || null, reviewCount: d.user_ratings_total || place.user_ratings_total || 0, placeId: place.place_id, lat: pLat, lng: pLng, distanceMiles: dm, distanceLabel: fmtDist(dm), reviews: reviews };
            } catch(e) {
              return { name: place.name, address: place.vicinity, rating: place.rating || null, reviewCount: place.user_ratings_total || 0, placeId: place.place_id, reviews: [] };
            }
          }));
          return detailed.sort(function(a, b) { return (a.distanceMiles !== null ? a.distanceMiles : 999) - (b.distanceMiles !== null ? b.distanceMiles : 999); });
        } catch(e) { return []; }
      }

      // LIGHT search — uses Nearby Search data only, NO Details API call (used for commercial categories)
      // Nearby Search already returns name, vicinity, rating, review count, and geometry — enough for commercial targets
      async function searchLight(query, radius, maxN) {
        try {
          var url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' + lat + ',' + lng + '&radius=' + radius + '&keyword=' + encodeURIComponent(query) + '&key=' + GOOGLE_KEY;
          var data = await (await fetch(url)).json();
          if (!data.results || data.results.length === 0) return [];
          return data.results.slice(0, maxN).map(function(place) {
            var pLat = place.geometry ? place.geometry.location.lat : null;
            var pLng = place.geometry ? place.geometry.location.lng : null;
            var dm = distMiles(lat, lng, pLat, pLng);
            return {
              name: place.name,
              address: place.vicinity,
              rating: place.rating || null,
              reviewCount: place.user_ratings_total || 0,
              placeId: place.place_id,
              lat: pLat,
              lng: pLng,
              distanceMiles: dm,
              distanceLabel: fmtDist(dm),
              reviews: []
            };
          }).sort(function(a, b) {
            return (a.distanceMiles !== null ? a.distanceMiles : 999) - (b.distanceMiles !== null ? b.distanceMiles : 999);
          });
        } catch(e) { return []; }
      }

      // Run all searches in parallel
      // Competitors + Apartments: full Details + reviews
      // Commercial categories: lightweight Nearby only — eliminates ~35 API calls
      var results = await Promise.all([
        searchFull('laundromat coin laundry wash fold', 5000, 8, false),
        searchFull('apartment complex', 1500, 8, true),
        searchLight('hotel motel inn suites', 3200, 4),
        searchLight('gym fitness center boxing martial arts', 3200, 4),
        searchLight('medical clinic dental urgent care', 3200, 4),
        searchLight('restaurant food service', 3200, 4),
        searchLight('hair salon nail spa beauty', 3200, 4),
        searchLight('auto repair mechanic shop', 3200, 4),
        searchLight('daycare childcare preschool', 3200, 4),
        getCensus(zipCode),
        getOwnerProfile()
      ]);

      var research = {
        address: formattedAddress, lat: lat, lng: lng, zipCode: zipCode,
        demographics: results[9],
        ownerProfile: results[10],
        competitors:  { results: results[0] },
        apartments:   { results: results[1] },
        hotels:       { results: results[2] },
        gyms:         { results: results[3] },
        medical:      { results: results[4] },
        restaurants:  { results: results[5] },
        salons:       { results: results[6] },
        automotive:   { results: results[7] },
        daycares:     { results: results[8] }
      };

      return res.status(200).json({ success: true, research: research });
    }

    // ── AI SYNTHESIS ──
    if (type === 'synthesize') {
      const { research, formData } = body;

      var systemPrompt = 'You are FranchiseIQ, an expert franchise market analyst. You produce market intelligence reports that read like a senior business consultant spent days researching this location.\n\nYour analysis must be:\n- SPECIFIC: Reference actual business names, real distances, actual review counts, and real demographic numbers\n- NARRATIVE: Write with conviction. Use phrases like "The data reveals..." or "What makes this location unusual is..."\n- PRIORITIZED: Rank everything by revenue impact and ease of execution\n- ACTIONABLE: Tell the owner exactly what to do, when, and why\n- HONEST: Name real competitive threats. Do not sugarcoat.\n\nSTORE PROFILE: Always lead with the owner\'s own business. Use their retrieved Google rating and review count. Compare directly against named competitors. If their rating is 4.5+ they are likely the market leader — say so.\n\nAPARTMENT TARGETING: Prioritize complexes that are CLOSEST first. Low-rated complexes (under 3.5 stars) with laundry complaints are HIGHEST priority. Mine review text for "broken machines", "laundry", "maintenance" — these signal warm leads. List minimum 5 complexes.\n\nCOMPETITOR ANALYSIS: Include minimum 5 competitors. Reference specific weaknesses from review text. Coin-only payment, dirty facilities, theft complaints are exploitable weaknesses.\n\nREPUTATION: Reference the owner\'s actual retrieved rating. Compare directly to every named competitor. Give specific tactical advice on review responses, new review generation, Google Business Profile posts.\n\nBUDGET: Calibrate all recommendations to the stated budget. Never exceed it. Budget breakdown must sum to stated range.\n\nCOMMERCIAL OUTREACH: Use distance to sequence — same block = Week 1, under 1 mile = Month 1, 1-2 miles = Month 2.\n\nOutput structured JSON only. Every field must be specific and data-grounded — no placeholder language.';

      var challengesText = (formData.challenges && formData.challenges.length > 0) ? formData.challenges.join(', ') : 'Not specified';
      var marketingText = (formData.marketing && formData.marketing.length > 0) ? formData.marketing.join(', ') : 'Not specified';
      var revenueText = formData.revenue || 'Not provided';
      var budgetMap = { 'under100': 'Under $100/month', '100-250': '$100-$250/month', '250-500': '$250-$500/month', '500-1000': '$500-$1,000/month', 'over1000': 'Over $1,000/month' };
      var budgetText = formData.budget ? (budgetMap[formData.budget] || formData.budget) : 'Not specified — assume $200-300/month';

      function summarize(cat) {
        if (!research[cat] || !research[cat].results || research[cat].results.length === 0) return 'None found nearby';
        return research[cat].results.map(function(p) {
          var lines = [p.name + (p.distanceLabel ? ' [' + p.distanceLabel + ']' : '') + (p.address ? ' — ' + p.address : '')];
          if (p.rating) lines.push(p.rating + ' stars (' + (p.reviewCount || 0) + ' reviews)');
          if (p.reviews) p.reviews.forEach(function(r) { if (r.text && r.text.length > 20) lines.push('  Review (' + r.rating + 'star): "' + r.text.substring(0, 250) + '"'); });
          return lines.join('\n');
        }).join('\n\n');
      }

      var demoText = 'Census data unavailable';
      if (research.demographics) {
        var d = research.demographics;
        demoText = 'ZIP: ' + (d.zip || 'N/A') + '\nPopulation: ' + (d.totalPopulation ? d.totalPopulation.toLocaleString() : 'N/A') + '\nRenter-Occupied: ' + (d.renterPercentage !== null ? d.renterPercentage + '%' : 'N/A') + (d.renterPercentage > 45 ? ' (ABOVE AVERAGE — strong demand signal)' : '') + '\nMedian Income: ' + (d.medianHouseholdIncome || 'N/A') + '\nMedian Rent: ' + (d.medianGrossRent || 'N/A') + '\nMedian Age: ' + (d.medianAge || 'N/A') + '\nHousing Era: ' + (d.housingEra || 'N/A');
      }

      var ownerText = 'Could not retrieve — use competitor data for context';
      if (research.ownerProfile) {
        var op = research.ownerProfile;
        var revLines = (op.reviews || []).map(function(r) { return '  (' + r.rating + 'star): "' + r.text.substring(0, 200) + '"'; }).join('\n');
        ownerText = 'Name: ' + (op.name || 'N/A') + '\nRating: ' + (op.rating ? op.rating + ' stars' : 'N/A') + '\nReviews: ' + (op.reviewCount || 'N/A') + '\nPhone: ' + (op.phone || 'N/A') + (revLines ? '\nSample reviews:\n' + revLines : '');
      }

      var prompt = 'Analyze this WaveMAX Laundry franchise. Use review text for intelligence. Use Census data for demographics. Use distances to sequence outreach.\n\nFRANCHISE: ' + research.address + '\n\nOWNER GOOGLE PROFILE (auto-retrieved):\n' + ownerText + '\n\nOWNER CONTEXT:\n- Brand: ' + (formData.brand === 'wavemax' ? 'WaveMAX Laundry' : formData.brand) + '\n- Washers: ' + (formData.washers || 'N/A') + '\n- Dryers: ' + (formData.dryers || 'N/A') + '\n- Revenue: ' + revenueText + '\n- Budget: ' + budgetText + '\n- Challenges: ' + challengesText + '\n- Marketing: ' + marketingText + '\n\nDEMOGRAPHICS:\n' + demoText + '\n\nCOMPETITORS (sorted by distance — list minimum 5):\n' + summarize('competitors') + '\n\nAPARTMENTS (sorted closest first — list minimum 5, prioritize low-rated complexes with laundry complaints):\n' + summarize('apartments') + '\n\nHOTELS:\n' + summarize('hotels') + '\n\nGYMS:\n' + summarize('gyms') + '\n\nMEDICAL & DENTAL:\n' + summarize('medical') + '\n\nRESTAURANTS:\n' + summarize('restaurants') + '\n\nSALONS & SPAS:\n' + summarize('salons') + '\n\nAUTO REPAIR SHOPS:\n' + summarize('automotive') + '\n\nDAYCARES & CHILDCARE:\n' + summarize('daycares') + '\n\nReturn ONLY valid JSON with this structure:\n\n{\n  "storeProfile": {\n    "headline": "One sentence on this owner\'s competitive position — reference their actual rating vs competitors",\n    "rating": "X.X",\n    "reviewCount": "XXX",\n    "ratingContext": "2-3 sentences comparing their rating to named competitors",\n    "washers": "XX",\n    "dryers": "XX",\n    "strengthSummary": "2-3 sentences on what this location already has going for it",\n    "immediateOpportunity": "The single most important action in the next 7 days"\n  },\n  "locationSummary": {\n    "headline": "Sharp specific sentence on biggest market opportunity",\n    "overview": "3-4 sentence narrative grounded in actual data",\n    "opportunityScore": 85,\n    "topOpportunity": "Single highest-revenue opportunity"\n  },\n  "marketResearch": {\n    "demographics": {\n      "headline": "What the demographic profile means for this business",\n      "renterPercentage": "XX%",\n      "totalPopulation": "XX,XXX",\n      "medianIncome": "$XX,XXX",\n      "housingEra": "description",\n      "keyInsight": "2-3 sentences on what these numbers mean for laundromat demand here"\n    },\n    "competitorAnalysis": {\n      "summary": "3-4 sentences on competitive landscape referencing specific names and review weaknesses",\n      "competitors": [\n        {"name": "exact name", "address": "address", "distanceLabel": "X.X miles away", "rating": 4.2, "reviewCount": 180, "threat": "High/Medium/Low", "weakness": "Specific weakness from review text", "opportunityAngle": "How this creates an opening"}\n      ],\n      "competitiveAdvantage": "2-3 sentences on this owner\'s specific advantages"\n    },\n    "apartmentOpportunity": {\n      "summary": "3-4 sentences referencing specific complex names, distances, and laundry frustration signals",\n      "totalComplexes": 5,\n      "estimatedHouseholds": 1000,\n      "monthlyLaundrySpend": "$20,000",\n      "topTargets": [\n        {"name": "exact name", "address": "address", "distanceLabel": "X.X miles away", "priority": "High/Medium/Low", "rating": 3.0, "reviewCount": 197, "laundryFrustration": "Specific complaint from reviews or proximity rationale", "reason": "Why this complex is a priority"}\n      ]\n    },\n    "reputationAudit": {\n      "currentRating": "X.X stars",\n      "reviewCount": "XXX reviews",\n      "ratingVsMarket": "Direct comparison to every named competitor",\n      "currentStrength": "2-3 sentences on reputation as a competitive asset",\n      "recommendations": ["Specific tactic 1", "Specific tactic 2", "Specific tactic 3", "Specific tactic 4"]\n    }\n  },\n  "marketingActionPlan": {\n    "summary": "2-3 sentences referencing specific market conditions and stated budget",\n    "tactics": [\n      {"rank": 1, "title": "Tactic name", "category": "Apartment Outreach / Commercial / Digital / In-Store", "description": "3-4 sentences with specific names and actionable steps", "effort": "Low/Medium/High", "impact": "Low/Medium/High", "timeframe": "Week 1-2 / Month 1 / Ongoing", "estimatedMonthlyRevenue": "$X,XXX-X,XXX"}\n    ],\n    "budgetAllocation": {\n      "total": "Must match stated budget",\n      "breakdown": [{"category": "name", "amount": "$XX", "rationale": "specific rationale"}]\n    },\n    "checklist90Day": {\n      "week1_2": ["action naming real businesses", "action 2", "action 3"],\n      "month1": ["action 1", "action 2", "action 3"],\n      "month2": ["action 1", "action 2"],\n      "month3": ["action 1", "action 2"]\n    }\n  },\n  "commercialTargets": {\n    "summary": "3-4 sentences on commercial opportunity referencing specific categories and distance clusters",\n    "totalEstimatedMonthlyRevenue": "$X,XXX-X,XXX",\n    "outreachPhases": {\n      "phase1": "Week 1 — name specific same-block or walking-distance targets",\n      "phase2": "Month 1 — name under-1-mile targets by name and category",\n      "phase3": "Month 2 — describe 1-2 mile targets"\n    },\n    "targets": [\n      {"businessName": "exact name", "category": "Hotel/Gym/Medical/Restaurant/Salon/Auto/Other", "address": "address", "distanceLabel": "X.X miles away", "priority": "High/Medium/Low", "estimatedMonthlyRevenue": "$XXX-XXX", "pitchAngle": "Specific pitch for this business", "bestApproachTime": "When and how to approach"}\n    ]\n  },\n  "collateral": {\n    "onePager": {\n      "headline": "Compelling commercial headline",\n      "subheadline": "Supporting line",\n      "bulletPoints": ["benefit 1", "benefit 2", "benefit 3", "benefit 4"],\n      "callToAction": "Specific CTA",\n      "contactPrompt": "How to reach out"\n    },\n    "doorHanger": {\n      "headline": "Headline referencing proximity to closest apartments",\n      "offerLine": "Compelling offer for residents",\n      "bulletPoints": ["benefit 1", "benefit 2", "benefit 3"],\n      "callToAction": "CTA with address"\n    }\n  }\n}';

      var aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 6000, system: systemPrompt, messages: [{ role: 'user', content: prompt }] })
      });

      var aiData = await aiRes.json();
      if (!aiRes.ok) return res.status(aiRes.status).json({ error: aiData.error || 'AI API error' });

      var text = (aiData.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');

      try {
        var clean = text.replace(/```json|```/g, '').trim();
        var parsed = JSON.parse(clean);
        return res.status(200).json({ success: true, report: parsed });
      } catch(e) {
        return res.status(200).json({ success: false, error: 'Parse error', raw: text });
      }
    }

    return res.status(400).json({ error: 'Unknown type: ' + type });

  } catch(err) {
    return res.status(500).json({ error: { message: err.message } });
  }
};

