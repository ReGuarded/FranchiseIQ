// FranchiseIQ v1.1 — API handler
// Upgrades: review text from Places API, Census demographics, distance calculations, richer synthesis prompt
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { type } = body;

    // ── PLACES RESEARCH PIPELINE ──
    if (type === 'research') {
      const { address } = body;
      const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

      if (!GOOGLE_KEY) {
        return res.status(200).json({ error: 'Google Maps API key not configured' });
      }

      // Step 1: Geocode the franchise address to lat/lng
      const geoUrl = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
        encodeURIComponent(address) + '&key=' + GOOGLE_KEY;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json();

      if (!geoData.results || geoData.results.length === 0) {
        return res.status(200).json({ error: 'Address not found', debug: geoData.status });
      }

      const lat = geoData.results[0].geometry.location.lat;
      const lng = geoData.results[0].geometry.location.lng;
      const formattedAddress = geoData.results[0].formatted_address;

      // Extract zip code from geocode result for Census lookup
      var zipCode = null;
      var addressComponents = geoData.results[0].address_components || [];
      for (var i = 0; i < addressComponents.length; i++) {
        if (addressComponents[i].types.indexOf('postal_code') !== -1) {
          zipCode = addressComponents[i].long_name;
          break;
        }
      }

      // ── HELPER: Calculate distance in miles between two lat/lng points ──
      function distanceMiles(lat1, lng1, lat2, lng2) {
        if (!lat1 || !lng1 || !lat2 || !lng2) return null;
        var R = 3958.8;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLng = (lng2 - lng1) * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng/2) * Math.sin(dLng/2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return Math.round(R * c * 10) / 10;
      }

      function formatDistance(miles) {
        if (miles === null) return null;
        if (miles < 0.1) return 'Same block';
        if (miles < 0.3) return 'Walking distance (' + miles + ' mi)';
        return miles + ' miles away';
      }

      // Step 2: Fetch Census demographic data for zip code
      async function fetchCensusData(zip) {
        if (!zip) return null;
        try {
          var censusUrl = 'https://api.census.gov/data/2022/acs/acs5?get=' +
            'B01003_001E,' +
            'B25003_003E,' +
            'B25003_001E,' +
            'B19013_001E,' +
            'B25064_001E,' +
            'B01002_001E,' +
            'B25035_001E' +
            '&for=zip%20code%20tabulation%20area:' + zip;

          var censusRes = await fetch(censusUrl);
          var censusData = await censusRes.json();

          if (!censusData || censusData.length < 2) return null;

          var headers = censusData[0];
          var values = censusData[1];

          function getVal(varName) {
            var idx = headers.indexOf(varName);
            if (idx === -1) return null;
            var v = parseInt(values[idx]);
            return isNaN(v) || v < 0 ? null : v;
          }

          var totalPop = getVal('B01003_001E');
          var renterUnits = getVal('B25003_003E');
          var totalUnits = getVal('B25003_001E');
          var medianIncome = getVal('B19013_001E');
          var medianRent = getVal('B25064_001E');
          var medianAge = getVal('B01002_001E');
          var medianYearBuilt = getVal('B25035_001E');

          var renterPct = (renterUnits && totalUnits) ? Math.round((renterUnits / totalUnits) * 100) : null;

          return {
            zip: zip,
            totalPopulation: totalPop,
            renterPercentage: renterPct,
            medianHouseholdIncome: medianIncome ? '$' + medianIncome.toLocaleString() : null,
            medianGrossRent: medianRent ? '$' + medianRent.toLocaleString() : null,
            medianAge: medianAge,
            medianYearBuilt: medianYearBuilt,
            housingEra: medianYearBuilt ? (medianYearBuilt < 1980 ? '1960s-1970s (older stock, fewer in-unit hookups)' :
              medianYearBuilt < 1995 ? '1980s-1990s (mixed-age stock)' : '1990s-2000s (newer stock)') : null
          };
        } catch(e) {
          return null;
        }
      }

      // Step 3: Run all location searches in parallel
      const searches = [
        { key: 'competitors',  query: 'laundromat coin laundry wash fold',     radius: 8000, label: 'Direct Competitors' },
        { key: 'apartments',   query: 'apartment complex',                      radius: 6000, label: 'Apartment Complexes' },
        { key: 'hotels',       query: 'hotel motel inn suites',                 radius: 8000, label: 'Hotels & Motels' },
        { key: 'gyms',         query: 'gym fitness center boxing martial arts', radius: 5000, label: 'Gyms & Fitness Centers' },
        { key: 'medical',      query: 'medical clinic dental urgent care',      radius: 6000, label: 'Medical & Dental' },
        { key: 'restaurants',  query: 'restaurant cafe food service',           radius: 4000, label: 'Restaurants & Food Service' },
        { key: 'salons',       query: 'hair salon nail spa beauty',             radius: 4000, label: 'Salons & Spas' },
        { key: 'automotive',   query: 'auto repair mechanic shop',              radius: 5000, label: 'Auto Repair Shops' }
      ];

      async function searchPlaces(searchQuery, searchRadius) {
        const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' +
          lat + ',' + lng +
          '&radius=' + searchRadius +
          '&keyword=' + encodeURIComponent(searchQuery) +
          '&key=' + GOOGLE_KEY;

        const placesRes = await fetch(url);
        const placesData = await placesRes.json();

        if (!placesData.results || placesData.results.length === 0) {
          return [];
        }

        const top6 = placesData.results.slice(0, 6);
        const detailed = await Promise.all(top6.map(async function(place) {
          try {
            const detailUrl = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' +
              place.place_id +
              '&fields=name,formatted_address,formatted_phone_number,rating,user_ratings_total,opening_hours,geometry,website,reviews' +
              '&key=' + GOOGLE_KEY;
            const detailRes = await fetch(detailUrl);
            const detailData = await detailRes.json();
            const d = detailData.result || {};

            var reviewSnippets = [];
            if (d.reviews && d.reviews.length > 0) {
              reviewSnippets = d.reviews.slice(0, 3).map(function(r) {
                return {
                  rating: r.rating,
                  text: r.text ? r.text.substring(0, 300) : '',
                  authorName: r.author_name || ''
                };
              }).filter(function(r) { return r.text.length > 20; });
            }

            var placeLat = d.geometry ? d.geometry.location.lat : (place.geometry ? place.geometry.location.lat : null);
            var placeLng = d.geometry ? d.geometry.location.lng : (place.geometry ? place.geometry.location.lng : null);
            var distMiles = distanceMiles(lat, lng, placeLat, placeLng);

            return {
              name: d.name || place.name,
              address: d.formatted_address || place.vicinity,
              phone: d.formatted_phone_number || null,
              website: d.website || null,
              rating: d.rating || place.rating || null,
              reviewCount: d.user_ratings_total || place.user_ratings_total || 0,
              isOpen: d.opening_hours ? d.opening_hours.open_now : null,
              placeId: place.place_id,
              lat: placeLat,
              lng: placeLng,
              distanceMiles: distMiles,
              distanceLabel: formatDistance(distMiles),
              reviews: reviewSnippets
            };
          } catch(e) {
            return {
              name: place.name,
              address: place.vicinity,
              rating: place.rating || null,
              reviewCount: place.user_ratings_total || 0,
              placeId: place.place_id,
              reviews: []
            };
          }
        }));

        return detailed.sort(function(a, b) {
          var dA = a.distanceMiles !== null ? a.distanceMiles : 999;
          var dB = b.distanceMiles !== null ? b.distanceMiles : 999;
          return dA - dB;
        });
      }

      // Run Places searches + Census lookup in parallel
      const [placesResults, censusData] = await Promise.all([
        Promise.all(
          searches.map(function(s) {
            return searchPlaces(s.query, s.radius).then(function(data) {
              return { key: s.key, label: s.label, data: data };
            });
          })
        ),
        fetchCensusData(zipCode)
      ]);

      const research = {
        address: formattedAddress,
        lat: lat,
        lng: lng,
        zipCode: zipCode,
        demographics: censusData
      };

      placesResults.forEach(function(r) {
        research[r.key] = { label: r.label, results: r.data };
      });

      return res.status(200).json({ success: true, research: research });
    }

    // ── AI SYNTHESIS ──
    if (type === 'synthesize') {
      const { research, formData } = body;

      const systemPrompt = `You are FranchiseIQ, an expert franchise market analyst and local business strategist. You produce market intelligence reports that read like they were written by a senior business consultant who spent days researching the location — not a generic AI tool.

Your analysis must be:
- SPECIFIC: Reference actual business names, real distances, actual review counts, and real demographic numbers from the data provided
- NARRATIVE: Write with conviction and insight. Use phrases like "The data reveals..." or "What makes this location unusual is..."
- PRIORITIZED: Rank everything by revenue impact and ease of execution
- ACTIONABLE: Tell the owner exactly what to do, when, and why — not vague suggestions
- HONEST: Name real competitive threats. Do not sugarcoat weaknesses.
- CONSULTANT-GRADE: Your tone should feel like a senior market brief, not a marketing brochure

When review text is provided for competitors or apartment complexes, mine it aggressively:
- Quote or reference specific complaints to identify competitor weaknesses
- Identify frustrated apartment residents as warm leads
- Look for payment friction, cleanliness failures, or staff issues in reviews
- Use review signals to calibrate threat levels and pitch angles for commercial targets

When Census demographics are provided, weave them into the narrative:
- Renter percentage above 45% is a strong laundromat demand signal — call it out
- Housing era before 1980 means very few in-unit washer/dryer hookups — this is a structural advantage
- Median income calibrates pricing sensitivity and wash & fold potential
- Population density anchors market size estimates

For commercial targets, use distance data to sequence outreach logically:
- Same block or walking distance = Week 1, zero budget, walk over and introduce yourself
- Under 1 mile = Month 1 canvassing run with printed materials
- 1-3 miles = Month 2 with more targeted outreach

You always output structured JSON. Every text field must contain rich, specific, consultant-quality prose — never placeholder language.`;

      const challengesText = formData.challenges && formData.challenges.length > 0
        ? formData.challenges.join(', ') : 'Not specified';
      const marketingText = formData.marketing && formData.marketing.length > 0
        ? formData.marketing.join(', ') : 'Not specified';
      const revenueText = formData.revenue || 'Not provided';

      function summarizePlaces(category) {
        if (!research[category] || !research[category].results || research[category].results.length === 0) {
          return 'None found nearby';
        }
        return research[category].results.map(function(p) {
          var lines = [];
          var header = p.name;
          if (p.distanceLabel) header += ' [' + p.distanceLabel + ']';
          if (p.address) header += ' — ' + p.address;
          lines.push(header);
          var meta = [];
          if (p.rating) meta.push(p.rating + ' stars (' + p.reviewCount + ' reviews)');
          if (p.phone) meta.push('Phone: ' + p.phone);
          if (meta.length > 0) lines.push(meta.join(' | '));
          if (p.reviews && p.reviews.length > 0) {
            p.reviews.forEach(function(r) {
              if (r.text && r.text.length > 20) {
                lines.push('  Review (' + r.rating + 'star): "' + r.text.substring(0, 250) + '"');
              }
            });
          }
          return lines.join('\n');
        }).join('\n\n');
      }

      var demoSection = 'Census data not available for this zip code';
      if (research.demographics) {
        var d = research.demographics;
        demoSection = [
          'ZIP Code: ' + (d.zip || 'N/A'),
          'Total Population: ' + (d.totalPopulation ? d.totalPopulation.toLocaleString() : 'N/A'),
          'Renter-Occupied Housing: ' + (d.renterPercentage !== null ? d.renterPercentage + '%' : 'N/A') +
            (d.renterPercentage && d.renterPercentage > 45 ? ' (ABOVE AVERAGE — strong laundromat demand signal)' : ''),
          'Median Household Income: ' + (d.medianHouseholdIncome || 'N/A'),
          'Median Gross Rent: ' + (d.medianGrossRent || 'N/A'),
          'Median Age: ' + (d.medianAge ? d.medianAge + ' years' : 'N/A'),
          'Housing Era: ' + (d.housingEra || 'N/A')
        ].join('\n');
      }

      const researchSummary = `
FRANCHISE LOCATION: ${research.address}
ZIP CODE: ${research.zipCode || 'N/A'}

NEIGHBORHOOD DEMOGRAPHICS (US Census ACS Data):
${demoSection}

DIRECT COMPETITORS — sorted by distance:
${summarizePlaces('competitors')}

APARTMENT COMPLEXES NEARBY — sorted by distance:
${summarizePlaces('apartments')}

HOTELS & MOTELS NEARBY:
${summarizePlaces('hotels')}

GYMS & FITNESS CENTERS NEARBY:
${summarizePlaces('gyms')}

MEDICAL & DENTAL NEARBY:
${summarizePlaces('medical')}

RESTAURANTS & FOOD SERVICE NEARBY:
${summarizePlaces('restaurants')}

SALONS & SPAS NEARBY:
${summarizePlaces('salons')}

AUTO REPAIR SHOPS NEARBY:
${summarizePlaces('automotive')}

OWNER-PROVIDED CONTEXT:
- Franchise brand: ${formData.brand === 'wavemax' ? 'WaveMAX Laundry' : formData.brand}
- Number of washers: ${formData.washers || 'Not provided'}
- Number of dryers: ${formData.dryers || 'Not provided'}
- Monthly revenue range: ${revenueText}
- Biggest growth challenges: ${challengesText}
- Current marketing activities: ${marketingText}
`;

      const userPrompt = `Analyze this WaveMAX Laundry franchise location. Use the review text to identify specific competitor weaknesses and apartment frustration signals. Use Census demographics to anchor the neighborhood analysis. Use distances to sequence commercial outreach realistically.

${researchSummary}

Return ONLY a valid JSON object with this exact structure. Every text field must be specific, data-grounded, and consultant-quality:

{
  "locationSummary": {
    "headline": "One sharp specific sentence capturing this location's biggest opportunity — reference real data",
    "overview": "3-4 sentence narrative grounded in actual demographics and competitive data — reference renter percentage, housing era, and competitor landscape by name",
    "opportunityScore": 85,
    "topOpportunity": "The single highest-revenue opportunity based on what the data actually shows"
  },
  "marketResearch": {
    "demographics": {
      "headline": "One sentence on what the demographic profile means for this business",
      "renterPercentage": "XX%",
      "totalPopulation": "XX,XXX",
      "medianIncome": "$XX,XXX",
      "housingEra": "description of housing era and what it means for hookup scarcity",
      "keyInsight": "2-3 sentences on what these specific numbers mean for laundromat demand at this address"
    },
    "competitorAnalysis": {
      "summary": "3-4 sentences referencing specific competitor names, their actual ratings, and weaknesses from their reviews",
      "competitors": [
        {
          "name": "exact name",
          "address": "address",
          "distanceLabel": "X.X miles away",
          "rating": 4.2,
          "reviewCount": 180,
          "threat": "High/Medium/Low",
          "weakness": "Specific weakness from their actual review text",
          "opportunityAngle": "How this creates an opening"
        }
      ],
      "competitiveAdvantage": "2-3 sentences on WaveMAX specific advantages over the named competitors"
    },
    "apartmentOpportunity": {
      "summary": "3-4 sentences referencing specific complex names, ratings, and any laundry frustration signals from reviews",
      "totalComplexes": 4,
      "estimatedHouseholds": 800,
      "monthlyLaundrySpend": "$16,000",
      "topTargets": [
        {
          "name": "exact complex name",
          "address": "address",
          "distanceLabel": "X.X miles away",
          "priority": "High/Medium/Low",
          "rating": 3.2,
          "reviewCount": 180,
          "reason": "Specific reason based on distance, review signals, or laundry frustration"
        }
      ]
    },
    "reputationAudit": {
      "currentStrength": "Analysis of WaveMAX reputation position relative to named competitors",
      "recommendations": ["action 1", "action 2", "action 3", "action 4"]
    }
  },
  "marketingActionPlan": {
    "summary": "2-3 sentences referencing specific market conditions — renter percentage, competitor weaknesses, apartment proximity",
    "tactics": [
      {
        "rank": 1,
        "title": "Specific tactic name",
        "category": "Apartment Outreach / Commercial / Digital / In-Store",
        "description": "3-4 sentences with specific business names, distances, and actionable steps from the research",
        "effort": "Low/Medium/High",
        "impact": "Low/Medium/High",
        "timeframe": "Week 1-2 / Month 1 / Ongoing",
        "estimatedMonthlyRevenue": "$X,XXX-X,XXX"
      }
    ],
    "budgetAllocation": {
      "total": "$XXX/month recommended",
      "breakdown": [
        {"category": "name", "amount": "$XX", "rationale": "specific rationale for this market"}
      ]
    },
    "checklist90Day": {
      "week1_2": ["specific action naming real nearby businesses or complexes", "action 2", "action 3"],
      "month1": ["action 1", "action 2", "action 3"],
      "month2": ["action 1", "action 2"],
      "month3": ["action 1", "action 2"]
    }
  },
  "commercialTargets": {
    "summary": "3-4 sentences on the commercial opportunity referencing specific categories and distance clusters",
    "totalEstimatedMonthlyRevenue": "$X,XXX-X,XXX",
    "outreachPhases": {
      "phase1": "Week 1 — name specific same-block or walking-distance targets",
      "phase2": "Month 1 — describe under-1-mile canvassing targets by name and category",
      "phase3": "Month 2 — describe 1-3 mile targets"
    },
    "targets": [
      {
        "businessName": "exact name from research data",
        "category": "Hotel / Gym / Medical / Restaurant / Salon / Auto / Other",
        "address": "address",
        "distanceLabel": "X.X miles away",
        "priority": "High/Medium/Low",
        "estimatedMonthlyRevenue": "$XXX-XXX",
        "pitchAngle": "Specific pitch referencing what this business does and their laundry needs — use review signals if available",
        "bestApproachTime": "When and how to approach this specific business type"
      }
    ]
  },
  "collateral": {
    "onePager": {
      "headline": "Compelling commercial headline specific to this location",
      "subheadline": "Supporting line referencing this location's actual strengths",
      "bulletPoints": ["benefit with specific detail", "benefit 2", "benefit 3", "benefit 4"],
      "callToAction": "Specific CTA",
      "contactPrompt": "How to reach out"
    },
    "doorHanger": {
      "headline": "Attention-grabbing headline referencing proximity to these specific apartments",
      "offerLine": "Compelling offer for first-time residents",
      "bulletPoints": ["resident benefit 1", "resident benefit 2", "resident benefit 3"],
      "callToAction": "CTA with address reference"
    }
  }
}`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 6000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });

      const aiData = await aiRes.json();

      if (!aiRes.ok) {
        return res.status(aiRes.status).json({ error: aiData.error || 'AI API error' });
      }

      const text = (aiData.content || [])
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('');

      try {
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        return res.status(200).json({ success: true, report: parsed });
      } catch(e) {
        return res.status(200).json({ success: false, error: 'Parse error', raw: text });
      }
    }

    // ── FALLBACK ──
    return res.status(400).json({ error: 'Unknown request type: ' + type });

  } catch(err) {
    return res.status(500).json({ error: { message: err.message, stack: err.stack } });
  }
};

