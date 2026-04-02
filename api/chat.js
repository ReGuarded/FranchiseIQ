// FranchiseIQ v1.0 — API handler
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

      // Step 2: Run all location searches in parallel
      const searches = [
        { key: 'competitors',   query: 'laundromat coin laundry',      radius: 8000,  label: 'Direct Competitors' },
        { key: 'apartments',    query: 'apartment complex',             radius: 6000,  label: 'Apartment Complexes' },
        { key: 'hotels',        query: 'hotel motel inn',               radius: 8000,  label: 'Hotels & Motels' },
        { key: 'gyms',          query: 'gym fitness center',            radius: 5000,  label: 'Gyms & Fitness Centers' },
        { key: 'medical',       query: 'medical clinic hospital',       radius: 8000,  label: 'Medical Facilities' },
        { key: 'restaurants',   query: 'restaurant food service',       radius: 5000,  label: 'Restaurants & Food Service' }
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

        // Get details for top 5 results
        const top5 = placesData.results.slice(0, 5);
        const detailed = await Promise.all(top5.map(async function(place) {
          try {
            const detailUrl = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' +
              place.place_id +
              '&fields=name,formatted_address,formatted_phone_number,rating,user_ratings_total,opening_hours,geometry,website' +
              '&key=' + GOOGLE_KEY;
            const detailRes = await fetch(detailUrl);
            const detailData = await detailRes.json();
            const d = detailData.result || {};
            return {
              name: d.name || place.name,
              address: d.formatted_address || place.vicinity,
              phone: d.formatted_phone_number || null,
              website: d.website || null,
              rating: d.rating || place.rating || null,
              reviewCount: d.user_ratings_total || place.user_ratings_total || 0,
              isOpen: d.opening_hours ? d.opening_hours.open_now : null,
              placeId: place.place_id,
              lat: place.geometry ? place.geometry.location.lat : null,
              lng: place.geometry ? place.geometry.location.lng : null
            };
          } catch(e) {
            return {
              name: place.name,
              address: place.vicinity,
              rating: place.rating || null,
              reviewCount: place.user_ratings_total || 0,
              placeId: place.place_id
            };
          }
        }));

        return detailed.sort(function(a, b) { return (b.reviewCount || 0) - (a.reviewCount || 0); });
      }

      // Run all searches in parallel
      const results = await Promise.all(
        searches.map(function(s) {
          return searchPlaces(s.query, s.radius).then(function(data) {
            return { key: s.key, label: s.label, data: data };
          });
        })
      );

      // Build research object
      const research = {
        address: formattedAddress,
        lat: lat,
        lng: lng
      };

      results.forEach(function(r) {
        research[r.key] = { label: r.label, results: r.data };
      });

      return res.status(200).json({ success: true, research: research });
    }

    // ── AI SYNTHESIS ──
    if (type === 'synthesize') {
      const { research, formData } = body;

      const systemPrompt = `You are FranchiseIQ, an expert franchise market analyst specializing in laundromat and self-service laundry businesses. You produce strategic, actionable market intelligence reports for franchise owners.

Your analysis is:
- Specific to the franchise's actual address and real local data provided
- Prioritized by revenue impact and ease of execution
- Written in a confident, professional tone — like a senior business consultant
- Practical and immediately actionable, not generic advice
- Honest about challenges while optimistic about opportunities

You always output structured JSON so the report page can render each section clearly.`;

      const challengesText = formData.challenges && formData.challenges.length > 0
        ? formData.challenges.join(', ')
        : 'Not specified';

      const marketingText = formData.marketing && formData.marketing.length > 0
        ? formData.marketing.join(', ')
        : 'Not specified';

      const revenueText = formData.revenue || 'Not provided';

      // Summarize research data for the prompt
      function summarizePlaces(category) {
        if (!research[category] || !research[category].results || research[category].results.length === 0) {
          return 'None found nearby';
        }
        return research[category].results.map(function(p) {
          var parts = [p.name, p.address];
          if (p.rating) parts.push(p.rating + ' stars (' + p.reviewCount + ' reviews)');
          if (p.phone) parts.push(p.phone);
          return parts.join(' | ');
        }).join('\n');
      }

      const researchSummary = `
FRANCHISE LOCATION: ${research.address}

DIRECT COMPETITORS (laundromats nearby):
${summarizePlaces('competitors')}

APARTMENT COMPLEXES NEARBY:
${summarizePlaces('apartments')}

HOTELS & MOTELS NEARBY:
${summarizePlaces('hotels')}

GYMS & FITNESS CENTERS NEARBY:
${summarizePlaces('gyms')}

MEDICAL FACILITIES NEARBY:
${summarizePlaces('medical')}

RESTAURANTS & FOOD SERVICE NEARBY:
${summarizePlaces('restaurants')}

OWNER-PROVIDED CONTEXT:
- Franchise brand: WaveMAX Laundry
- Number of washers: ${formData.washers || 'Not provided'}
- Number of dryers: ${formData.dryers || 'Not provided'}
- Monthly revenue range: ${revenueText}
- Biggest growth challenges: ${challengesText}
- Current marketing activities: ${marketingText}
`;

      const userPrompt = `Based on this real local market data for a WaveMAX Laundry franchise, generate a complete Market Growth Strategy Report.

${researchSummary}

Return ONLY a valid JSON object with this exact structure (no markdown, no preamble):

{
  "locationSummary": {
    "headline": "One punchy sentence summarizing the market opportunity",
    "overview": "2-3 sentence narrative about this location's market position and biggest opportunity",
    "opportunityScore": 85,
    "topOpportunity": "Single biggest revenue opportunity in one sentence"
  },
  "marketResearch": {
    "competitorAnalysis": {
      "summary": "2-3 sentence analysis of the competitive landscape",
      "competitors": [
        {"name": "...", "address": "...", "rating": 4.2, "reviewCount": 180, "threat": "High/Medium/Low", "weakness": "one sentence on their weakness"}
      ],
      "competitiveAdvantage": "WaveMAX's key advantage over these competitors"
    },
    "apartmentOpportunity": {
      "summary": "2-3 sentence analysis of the apartment ecosystem opportunity",
      "totalComplexes": 4,
      "estimatedHouseholds": 800,
      "monthlyLaundrySpend": "$16,000",
      "topTargets": [
        {"name": "...", "address": "...", "priority": "High/Medium", "reason": "why this complex is a priority"}
      ]
    },
    "reputationAudit": {
      "currentStrength": "Analysis of their online reputation based on competitor context",
      "recommendations": ["specific action 1", "specific action 2", "specific action 3"]
    }
  },
  "marketingActionPlan": {
    "summary": "One paragraph overview of the recommended strategy approach",
    "tactics": [
      {
        "rank": 1,
        "title": "Tactic name",
        "category": "Apartment Outreach / Commercial / Digital / In-Store",
        "description": "2-3 sentences on what to do and why",
        "effort": "Low/Medium/High",
        "impact": "Low/Medium/High",
        "timeframe": "Week 1-2 / Month 1 / Ongoing",
        "estimatedMonthlyRevenue": "$500-1,500"
      }
    ],
    "budgetAllocation": {
      "total": "$300/month recommended",
      "breakdown": [
        {"category": "Google Business Profile & Ads", "amount": "$100", "rationale": "..."},
        {"category": "Print materials", "amount": "$75", "rationale": "..."},
        {"category": "Apartment outreach", "amount": "$75", "rationale": "..."},
        {"category": "Social media", "amount": "$50", "rationale": "..."}
      ]
    },
    "checklist90Day": {
      "week1_2": ["action 1", "action 2", "action 3"],
      "month1": ["action 1", "action 2", "action 3"],
      "month2": ["action 1", "action 2"],
      "month3": ["action 1", "action 2"]
    }
  },
  "commercialTargets": {
    "summary": "2-3 sentence overview of the commercial account opportunity",
    "totalEstimatedMonthlyRevenue": "$2,500–4,000",
    "targets": [
      {
        "businessName": "...",
        "category": "Hotel / Gym / Medical / Restaurant / Other",
        "address": "...",
        "priority": "High/Medium/Low",
        "estimatedMonthlyLbs": 200,
        "estimatedMonthlyRevenue": "$400-600",
        "pitchAngle": "One sentence on how to approach this specific business"
      }
    ]
  },
  "collateral": {
    "onePager": {
      "headline": "Catchy headline for the commercial one-pager",
      "subheadline": "Supporting line",
      "bulletPoints": ["benefit 1", "benefit 2", "benefit 3", "benefit 4"],
      "callToAction": "Specific CTA line",
      "contactPrompt": "How to reach out"
    },
    "doorHanger": {
      "headline": "Attention-grabbing headline for apartment residents",
      "offerLine": "Special offer or hook",
      "bulletPoints": ["resident benefit 1", "resident benefit 2", "resident benefit 3"],
      "callToAction": "CTA for residents"
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
          max_tokens: 4000,
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

