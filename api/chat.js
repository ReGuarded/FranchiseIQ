// FranchiseIQ v1.3
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

      const geoRes = await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + GOOGLE_KEY);
      const geoData = await geoRes.json();
      if (!geoData.results || geoData.results.length === 0) return res.status(200).json({ error: 'Address not found' });

      const lat = geoData.results[0].geometry.location.lat;
      const lng = geoData.results[0].geometry.location.lng;
      const formattedAddress = geoData.results[0].formatted_address;

      var zipCode = null;
      var comps = geoData.results[0].address_components || [];
      for (var i = 0; i < comps.length; i++) {
        if (comps[i].types.indexOf('postal_code') !== -1) { zipCode = comps[i].long_name; break; }
      }

      function distMiles(lat1, lng1, lat2, lng2) {
        if (!lat1 || !lng1 || !lat2 || !lng2) return null;
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
            }).sort(function(a, b) { return (a.d !== null ? a.d : 999) - (b.d !== null ? b.d : 999); }).map(function(c) { return c.place; });
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
              var reviews = (d.reviews || []).slice(0, 3).map(function(r) { return { rating: r.rating, text: (r.text || '').substring(0, 300) }; }).filter(function(r) { return r.text.length > 20; });
              return { name: d.name || place.name, address: d.formatted_address || place.vicinity, phone: d.formatted_phone_number || null, rating: d.rating || place.rating || null, reviewCount: d.user_ratings_total || place.user_ratings_total || 0, placeId: place.place_id, lat: pLat, lng: pLng, distanceMiles: dm, distanceLabel: fmtDist(dm), reviews: reviews };
            } catch(e) { return { name: place.name, address: place.vicinity, rating: place.rating || null, reviewCount: place.user_ratings_total || 0, placeId: place.place_id, reviews: [] }; }
          }));
          return detailed.sort(function(a, b) { return (a.distanceMiles !== null ? a.distanceMiles : 999) - (b.distanceMiles !== null ? b.distanceMiles : 999); });
        } catch(e) { return []; }
      }

      async function searchLight(query, radius, maxN) {
        try {
          var url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' + lat + ',' + lng + '&radius=' + radius + '&keyword=' + encodeURIComponent(query) + '&key=' + GOOGLE_KEY;
          var data = await (await fetch(url)).json();
          if (!data.results || data.results.length === 0) return [];
          return data.results.slice(0, maxN).map(function(place) {
            var pLat = place.geometry ? place.geometry.location.lat : null;
            var pLng = place.geometry ? place.geometry.location.lng : null;
            var dm = distMiles(lat, lng, pLat, pLng);
            return { name: place.name, address: place.vicinity, rating: place.rating || null, reviewCount: place.user_ratings_total || 0, placeId: place.place_id, lat: pLat, lng: pLng, distanceMiles: dm, distanceLabel: fmtDist(dm), reviews: [] };
          }).sort(function(a, b) { return (a.distanceMiles !== null ? a.distanceMiles : 999) - (b.distanceMiles !== null ? b.distanceMiles : 999); });
        } catch(e) { return []; }
      }

      var results = await Promise.all([
        searchFull('laundromat coin laundry wash fold', 5000, 4, false),
        searchFull('apartment complex', 1500, 6, true),
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

      var systemPrompt = [
        'You are FranchiseIQ, an expert franchise market analyst. You produce market intelligence reports that read like a senior business consultant spent days researching this location.',
        '',
        'Your analysis must be:',
        '- SPECIFIC: Reference actual business names, real distances, actual review counts, and real demographic numbers',
        '- NARRATIVE: Write with conviction. Use phrases like "The data reveals..." or "What makes this location unusual is..."',
        '- PRIORITIZED: Rank everything by revenue impact and ease of execution',
        '- ACTIONABLE: Tell the owner exactly what to do, when, and why',
        '- HONEST: Name real competitive threats. Do not sugarcoat.',
        '',
        'BUSINESS PROFILE & REPUTATION: Combine store stats and reputation into one rich section. Lead with rating and review count. Compare rating directly to named competitors. Mine the owner\'s own Google reviews for specific themes — cleanliness, staff names, machine quality. If staff are mentioned by name (e.g. Nora, Jessica), call them out specifically — named staff are a marketing moat. Identify one honest gap. Give 4 specific tactical actions.',
        '',
        'APARTMENT TARGETING: Prioritize complexes that are CLOSEST first. Low-rated complexes (under 3.5 stars) with laundry complaints are HIGHEST priority. Mine review text for broken machines, laundry, maintenance. List minimum 5 complexes.',
        '',
        'COMPETITOR ANALYSIS: Include minimum 5 competitors. Reference specific weaknesses from review text. Coin-only payment, dirty facilities, theft complaints are exploitable weaknesses.',
        '',
        'BUDGET: Calibrate all recommendations to the stated budget. Never exceed it.',
        '',
        'COMMERCIAL OUTREACH: Use distance to sequence — same block = Week 1, under 1 mile = Month 1, 1-2 miles = Month 2. Six categories: Hotels (linens/uniforms), Restaurants (daily kitchen laundry), Salons & Gyms (towels/gear), Medical & Dental (scrubs), Daycares (bibs/nap mats), Auto Shops (shop rags).',
        '',
        'Output structured JSON only. Every field must be specific and data-grounded.'
      ].join('\n');

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
        demoText = 'ZIP: ' + (d.zip || 'N/A') + '\nPopulation: ' + (d.totalPopulation ? d.totalPopulation.toLocaleString() : 'N/A') + '\nRenter-Occupied: ' + (d.renterPercentage !== null ? d.renterPercentage + '%' : 'N/A') + (d.renterPercentage > 45 ? ' (ABOVE AVERAGE)' : '') + '\nMedian Income: ' + (d.medianHouseholdIncome || 'N/A') + '\nMedian Rent: ' + (d.medianGrossRent || 'N/A') + '\nMedian Age: ' + (d.medianAge || 'N/A') + '\nHousing Era: ' + (d.housingEra || 'N/A');
      }

      var ownerText = 'Could not retrieve — use competitor data for context';
      if (research.ownerProfile) {
        var op = research.ownerProfile;
        var revLines = (op.reviews || []).map(function(r) { return '  (' + r.rating + 'star): "' + r.text.substring(0, 200) + '"'; }).join('\n');
        ownerText = 'Name: ' + (op.name || 'N/A') + '\nRating: ' + (op.rating ? op.rating + ' stars' : 'N/A') + '\nReviews: ' + (op.reviewCount || 'N/A') + '\nPhone: ' + (op.phone || 'N/A') + (revLines ? '\nSample reviews:\n' + revLines : '');
      }

      // Build the JSON template as a proper JS object then stringify — no escaping issues
      var jsonTemplate = {
        businessProfile: {
          headline: "One sharp sentence on market position — reference actual rating vs named competitors",
          rating: "X.X",
          reviewCount: "XXX",
          washers: "XX",
          dryers: "XX",
          ratingVsMarket: "2-3 sentences comparing rating directly to every named competitor — be specific about the gap",
          reviewThemes: [
            { theme: "Cleanliness", sampleQuote: "actual quote from their own Google reviews", marketingImplication: "what to do with this insight" },
            { theme: "Staff warmth", sampleQuote: "quote mentioning staff by name if available", marketingImplication: "implication" },
            { theme: "Machine quality or other prominent theme", sampleQuote: "quote", marketingImplication: "implication" }
          ],
          staffAdvantage: "If any staff mentioned by name in reviews (e.g. Nora, Jessica) call them out specifically — named staff are a marketing moat. If no names found, describe the personal service advantage.",
          oneGap: "The single honest weakness to address — e.g. payment friction, limited hours, low social media presence",
          immediateOpportunity: "The single most important action in the next 7 days",
          tacticalActions: ["Specific tactical action 1", "Specific action 2", "Specific action 3", "Specific action 4"]
        },
        locationSummary: {
          headline: "Sharp specific sentence on biggest market opportunity",
          overview: "3-4 sentence narrative grounded in actual data",
          opportunityScore: 85,
          topOpportunity: "Single highest-revenue opportunity"
        },
        marketResearch: {
          demographics: {
            headline: "What the demographic profile means for this business",
            renterPercentage: "XX%",
            totalPopulation: "XX,XXX",
            medianIncome: "$XX,XXX",
            housingEra: "description",
            keyInsight: "2-3 sentences on what these numbers mean for laundromat demand here"
          },
          competitorAnalysis: {
            summary: "3-4 sentences on competitive landscape referencing specific names and review weaknesses",
            competitors: [
              { name: "exact name", address: "address", distanceLabel: "X.X miles away", rating: 4.2, reviewCount: 180, threat: "High/Medium/Low", weakness: "Specific weakness from review text", opportunityAngle: "How this creates an opening" }
            ],
            competitiveAdvantage: "2-3 sentences on this owner's specific advantages"
          },
          apartmentOpportunity: {
            summary: "3-4 sentences referencing specific complex names, distances, and laundry frustration signals",
            totalComplexes: 5,
            estimatedHouseholds: 1000,
            monthlyLaundrySpend: "$20,000",
            topTargets: [
              { name: "exact name", address: "address", distanceLabel: "X.X miles away", priority: "High/Medium/Low", rating: 3.0, reviewCount: 197, laundryFrustration: "Specific complaint from reviews or proximity rationale", reason: "Why this complex is a priority" }
            ]
          }
        },
        marketingActionPlan: {
          summary: "2-3 sentences referencing specific market conditions and stated budget",
          tactics: [
            { rank: 1, title: "Tactic name", category: "Apartment Outreach / Commercial / Digital / In-Store", description: "3-4 sentences with specific names and actionable steps", effort: "Low/Medium/High", impact: "Low/Medium/High", timeframe: "Week 1-2 / Month 1 / Ongoing", estimatedMonthlyRevenue: "$X,XXX-X,XXX" }
          ],
          budgetAllocation: {
            total: "Must match stated budget",
            breakdown: [{ category: "name", amount: "$XX", rationale: "specific rationale" }]
          },
          checklist90Day: {
            week1_2: ["action naming real businesses", "action 2", "action 3"],
            month1: ["action 1", "action 2", "action 3"],
            month2: ["action 1", "action 2"],
            month3: ["action 1", "action 2"]
          }
        },
        commercialTargets: {
          summary: "3-4 sentences on commercial opportunity referencing specific categories and distance clusters",
          totalEstimatedMonthlyRevenue: "$X,XXX-X,XXX",
          outreachPhases: {
            phase1: "Week 1 — name specific same-block or walking-distance targets",
            phase2: "Month 1 — name under-1-mile targets by name and category",
            phase3: "Month 2 — describe 1-2 mile targets"
          },
          targets: [
            { businessName: "exact name", category: "Hotel/Gym/Medical/Restaurant/Salon/Auto/Daycare", address: "address", distanceLabel: "X.X miles away", priority: "High/Medium/Low", estimatedMonthlyRevenue: "$XXX-XXX", pitchAngle: "Specific pitch for this business", bestApproachTime: "When and how to approach" }
          ]
        },
        collateral: {
          onePager: {
            headline: "Compelling commercial headline",
            subheadline: "Supporting line",
            bulletPoints: ["benefit 1", "benefit 2", "benefit 3", "benefit 4"],
            callToAction: "Specific CTA",
            contactPrompt: "How to reach out"
          },
          doorHanger: {
            headline: "Headline referencing proximity to closest apartments",
            offerLine: "Compelling offer for residents",
            bulletPoints: ["benefit 1", "benefit 2", "benefit 3"],
            callToAction: "CTA with address"
          }
        }
      };

      var promptParts = [
        'Analyze this WaveMAX Laundry franchise. Use review text for intelligence. Use Census data for demographics. Use distances to sequence outreach.',
        '',
        'FRANCHISE: ' + research.address,
        '',
        'OWNER GOOGLE PROFILE (auto-retrieved):',
        ownerText,
        '',
        'OWNER CONTEXT:',
        '- Brand: ' + (formData.brand === 'wavemax' ? 'WaveMAX Laundry' : formData.brand),
        '- Washers: ' + (formData.washers || 'N/A'),
        '- Dryers: ' + (formData.dryers || 'N/A'),
        '- Revenue: ' + revenueText,
        '- Budget: ' + budgetText,
        '- Challenges: ' + challengesText,
        '- Marketing: ' + marketingText,
        '',
        'DEMOGRAPHICS:',
        demoText,
        '',
        'COMPETITORS (sorted by distance — list minimum 5):',
        summarize('competitors'),
        '',
        'APARTMENTS (sorted closest first — list minimum 5, prioritize low-rated with laundry complaints):',
        summarize('apartments'),
        '',
        'HOTELS:',
        summarize('hotels'),
        '',
        'GYMS:',
        summarize('gyms'),
        '',
        'MEDICAL & DENTAL:',
        summarize('medical'),
        '',
        'RESTAURANTS:',
        summarize('restaurants'),
        '',
        'SALONS & SPAS:',
        summarize('salons'),
        '',
        'AUTO REPAIR SHOPS:',
        summarize('automotive'),
        '',
        'DAYCARES & CHILDCARE:',
        summarize('daycares'),
        '',
        'Return ONLY valid JSON matching this exact structure (replace all placeholder values with real data):',
        '',
        JSON.stringify(jsonTemplate, null, 2)
      ];

      var prompt = promptParts.join('\n');

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

