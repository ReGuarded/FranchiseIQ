// FranchiseIQ v1.2 — API handler
// Upgrades: store profile section, tighter radii, more apartment results, min 5 competitors, stronger reputation prompt
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

      // Extract zip code for Census lookup
      var zipCode = null;
      var addressComponents = geoData.results[0].address_components || [];
      for (var i = 0; i < addressComponents.length; i++) {
        if (addressComponents[i].types.indexOf('postal_code') !== -1) {
          zipCode = addressComponents[i].long_name;
          break;
        }
      }

      // ── HELPER: Distance in miles ──
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

      // ── Census demographics ──
      async function fetchCensusData(zip) {
        if (!zip) return null;
        try {
          var censusUrl = 'https://api.census.gov/data/2022/acs/acs5?get=' +
            'B01003_001E,B25003_003E,B25003_001E,B19013_001E,B25064_001E,B01002_001E,B25035_001E' +
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
        } catch(e) { return null; }
      }

      // ── Step 2: Look up the owner's own Google Business Profile ──
      async function fetchOwnerProfile(ownerLat, ownerLng) {
        try {
          // Search for the franchise location itself using its coordinates
          const nearbyUrl = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' +
            ownerLat + ',' + ownerLng +
            '&radius=50' +
            '&keyword=laundromat+laundry' +
            '&key=' + GOOGLE_KEY;
          const nearbyRes = await fetch(nearbyUrl);
          const nearbyData = await nearbyRes.json();

          if (!nearbyData.results || nearbyData.results.length === 0) return null;

          // Take the closest result — should be the owner's own location
          const ownPlace = nearbyData.results[0];
          const detailUrl = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' +
            ownPlace.place_id +
            '&fields=name,rating,user_ratings_total,reviews,formatted_phone_number,opening_hours,website' +
            '&key=' + GOOGLE_KEY;
          const detailRes = await fetch(detailUrl);
          const detailData = await detailRes.json();
          const d = detailData.result || {};

          var ownerReviews = [];
          if (d.reviews && d.reviews.length > 0) {
            ownerReviews = d.reviews.slice(0, 5).map(function(r) {
              return {
                rating: r.rating,
                text: r.text ? r.text.substring(0, 300) : '',
                authorName: r.author_name || ''
              };
            }).filter(function(r) { return r.text.length > 10; });
          }

          return {
            name: d.name || ownPlace.name,
            rating: d.rating || ownPlace.rating || null,
            reviewCount: d.user_ratings_total || ownPlace.user_ratings_total || 0,
            phone: d.formatted_phone_number || null,
            website: d.website || null,
            reviews: ownerReviews
          };
        } catch(e) {
          return null;
        }
      }

      // ── Search config — tightened radii ──
      // Apartments: 3200m (2 miles), fetch top 20 then sort by distance
      // Competitors: 5000m (3 miles)
      // All commercial: 3200m (2 miles)
      const searches = [
        { key: 'competitors',  query: 'laundromat coin laundry wash fold',      radius: 5000, maxResults: 8,  presort: false, label: 'Direct Competitors' },
        { key: 'apartments',   query: 'apartment complex',                       radius: 3200, maxResults: 8,  presort: true,  label: 'Apartment Complexes' },
        { key: 'hotels',       query: 'hotel motel inn suites',                  radius: 3200, maxResults: 6,  presort: false, label: 'Hotels & Motels' },
        { key: 'gyms',         query: 'gym fitness center boxing martial arts',  radius: 3200, maxResults: 6,  presort: false, label: 'Gyms & Fitness Centers' },
        { key: 'medical',      query: 'medical clinic dental urgent care',       radius: 3200, maxResults: 6,  presort: false, label: 'Medical & Dental' },
        { key: 'restaurants',  query: 'restaurant cafe food service',            radius: 3200, maxResults: 6,  presort: false, label: 'Restaurants & Food Service' },
        { key: 'salons',       query: 'hair salon nail spa beauty',              radius: 3200, maxResults: 6,  presort: false, label: 'Salons & Spas' },
        { key: 'automotive',   query: 'auto repair mechanic shop',               radius: 3200, maxResults: 6,  presort: false, label: 'Auto Repair Shops' }
      ];

      async function searchPlaces(searchQuery, searchRadius, maxResults, presort) {
        const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' +
          lat + ',' + lng +
          '&radius=' + searchRadius +
          '&keyword=' + encodeURIComponent(searchQuery) +
          '&key=' + GOOGLE_KEY;

        const placesRes = await fetch(url);
        const placesData = await placesRes.json();

        if (!placesData.results || placesData.results.length === 0) return [];

        // For apartments: pre-sort by distance using coords already in Nearby Search response
        // This finds closest complexes WITHOUT extra API calls, then fetches Details only for top N
        var candidates = placesData.results;
        if (presort) {
          candidates = candidates.map(function(p) {
            var pLat = p.geometry ? p.geometry.location.lat : null;
            var pLng = p.geometry ? p.geometry.location.lng : null;
            return { place: p, dist: distanceMiles(lat, lng, pLat, pLng) };
          });
          candidates.sort(function(a, b) {
            return (a.dist !== null ? a.dist : 999) - (b.dist !== null ? b.dist : 999);
          });
          candidates = candidates.map(function(c) { return c.place; });
        }

        const topN = candidates.slice(0, maxResults);

        const detailed = await Promise.all(topN.map(async function(place) {
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

        // Sort by distance — closest first
        return detailed.sort(function(a, b) {
          var dA = a.distanceMiles !== null ? a.distanceMiles : 999;
          var dB = b.distanceMiles !== null ? b.distanceMiles : 999;
          return dA - dB;
        });
      }

      // Run all searches + Census + owner profile in parallel
      const [placesResults, censusData, ownerProfile] = await Promise.all([
        Promise.all(
          searches.map(function(s) {
            return searchPlaces(s.query, s.radius, s.maxResults, s.presort).then(function(data) {
              return { key: s.key, label: s.label, data: data };
            });
          })
        ),
        fetchCensusData(zipCode),
        fetchOwnerProfile(lat, lng)
      ]);

      const research = {
        address: formattedAddress,
        lat: lat,
        lng: lng,
        zipCode: zipCode,
        demographics: censusData,
        ownerProfile: ownerProfile
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

STORE PROFILE SECTION — Always lead with the owner's own business:
- Use their Google rating and review count to establish their market position
- Compare their rating directly against named competitors
- If their rating is 4.5+ they are likely the highest-rated laundromat in their market — say so
- Frame the store profile as "here is your current competitive position" before analyzing the market around them
- Revenue range (if provided) helps calibrate the scale of opportunity

APARTMENT TARGETING — Critical instructions:
- Prioritize complexes that are CLOSEST first — walking distance and same-block complexes are the highest priority
- Low-rated complexes (under 3.5 stars) with laundry complaints in reviews are HIGHEST priority targets
- A 3.0-star apartment complex directly across the street is worth more than a 4.5-star complex 1.5 miles away
- Mine review text aggressively for phrases like "broken machines", "laundry", "maintenance", "washer" — these signal frustrated residents who are warm leads
- Always list at least 5 apartment complexes if the data provides them

COMPETITOR ANALYSIS — Always include at least 5 competitors if data is available:
- Reference specific weaknesses found in their actual review text
- Coin-only payment, dirty facilities, theft complaints, unreliable hours are all exploitable weaknesses
- Quantify the threat: how many reviews do they have, how far are they, what is their rating trend

REPUTATION SECTION — This must be specific to the owner's actual Google position:
- Reference their actual rating and review count provided in the form
- Compare directly: "Your 4.8-star rating outperforms every competitor in this analysis"
- Give specific, tactical advice: how to respond to reviews, how to ask for new ones, what to post on Google Business Profile
- If their rating is exceptional, position it as a marketing asset to activate immediately

When Census demographics are provided, weave them into the narrative:
- Renter percentage above 45% is a strong laundromat demand signal — call it out
- Housing era before 1980 means very few in-unit washer/dryer hookups — this is a structural advantage
- Median income calibrates pricing sensitivity and wash & fold potential

When a monthly marketing budget is provided, calibrate ALL recommendations to that budget:
- Under $100/month: focus entirely on zero-cost tactics (in-person outreach, door hangers, Google Business Profile)
- $100-$250/month: add minimal print materials and basic social media
- $250-$500/month: include Google Ads, door hanger printing, and targeted outreach
- $500-$1,000/month: full digital + print + commercial outreach program
- Over $1,000/month: aggressive multi-channel strategy with paid advertising
Never recommend spending more than the stated budget. The budget breakdown must sum to the stated budget range.

For commercial targets, use distance data to sequence outreach:
- Same block or walking distance = Week 1, zero budget, walk over and introduce yourself
- Under 1 mile = Month 1 canvassing run with printed materials
- 1-2 miles = Month 2 with targeted outreach

You always output structured JSON. Every text field must contain rich, specific, consultant-quality prose — never placeholder language.`;

      const challengesText = formData.challenges && formData.challenges.length > 0
        ? formData.challenges.join(', ') : 'Not specified';
      const marketingText = formData.marketing && formData.marketing.length > 0
        ? formData.marketing.join(', ') : 'Not specified';
      const revenueText = formData.revenue || 'Not provided';

      var budgetLabels = {
        'under100': 'Under $100/month',
        '100-250': '$100 – $250/month',
        '250-500': '$250 – $500/month',
        '500-1000': '$500 – $1,000/month',
        'over1000': 'Over $1,000/month'
      };
      const budgetText = formData.budget
        ? (budgetLabels[formData.budget] || formData.budget)
        : 'Not specified — use conservative $200-300/month assumption';

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

      // Format owner profile for prompt
      var ownerProfileSection = 'Could not retrieve — use competitor data for context';
      if (research.ownerProfile) {
        var op = research.ownerProfile;
        var ownerReviewText = '';
        if (op.reviews && op.reviews.length > 0) {
          ownerReviewText = '\nOwner Google Reviews (sample):\n' + op.reviews.map(function(r) {
            return '  (' + r.rating + 'star) "' + r.text.substring(0, 200) + '"';
          }).join('\n');
        }
        ownerProfileSection = [
          'Business name: ' + (op.name || 'N/A'),
          'Google Rating: ' + (op.rating ? op.rating + ' stars' : 'N/A'),
          'Total Reviews: ' + (op.reviewCount || 'N/A'),
          'Phone: ' + (op.phone || 'N/A'),
          ownerReviewText
        ].join('\n');
      }

      const researchSummary = `
FRANCHISE LOCATION: ${research.address}
ZIP CODE: ${research.zipCode || 'N/A'}

OWNER'S GOOGLE BUSINESS PROFILE (auto-retrieved):
${ownerProfileSection}

OWNER-PROVIDED CONTEXT:
- Franchise brand: ${formData.brand === 'wavemax' ? 'WaveMAX Laundry' : formData.brand}
- Number of washers: ${formData.washers || 'Not provided'}
- Number of dryers: ${formData.dryers || 'Not provided'}
- Monthly revenue range: ${revenueText}
- Monthly marketing budget: ${budgetText}
- Biggest growth challenges: ${challengesText}
- Current marketing activities: ${marketingText}

NEIGHBORHOOD DEMOGRAPHICS (US Census ACS Data):
${demoSection}

DIRECT COMPETITORS — sorted by distance (minimum 5 required in output):
${summarizePlaces('competitors')}

APARTMENT COMPLEXES NEARBY — sorted by distance, closest first (minimum 5 required in output):
${summarizePlaces('apartments')}

HOTELS & MOTELS NEARBY (within 2 miles):
${summarizePlaces('hotels')}

GYMS & FITNESS CENTERS NEARBY (within 2 miles):
${summarizePlaces('gyms')}

MEDICAL & DENTAL NEARBY (within 2 miles):
${summarizePlaces('medical')}

RESTAURANTS & FOOD SERVICE NEARBY (within 2 miles):
${summarizePlaces('restaurants')}

SALONS & SPAS NEARBY (within 2 miles):
${summarizePlaces('salons')}

AUTO REPAIR SHOPS NEARBY (within 2 miles):
${summarizePlaces('automotive')}
`;

      const userPrompt = `Analyze this WaveMAX Laundry franchise location and generate a complete Market Growth Strategy Report.

Key instructions:
1. Open with a "Store Profile" section that establishes the owner's current competitive position using their Google rating vs competitors
2. List ALL apartment complexes provided — minimum 5 — prioritized by proximity AND laundry frustration signals from reviews
3. List minimum 5 competitors with specific weaknesses from their review text
4. Reputation section must reference the owner's actual rating and give specific tactical advice
5. All budget recommendations must fit within the stated monthly budget

${researchSummary}

Return ONLY a valid JSON object — no markdown, no preamble:

{
  "storeProfile": {
    "headline": "One sentence establishing this owner's current market position — reference their actual rating vs competitors",
    "rating": "X.X",
    "reviewCount": "XXX",
    "ratingContext": "2-3 sentences comparing their rating to the named competitors found in this market — is it the highest? By how much?",
    "revenueRange": "as provided",
    "washers": "as provided",
    "dryers": "as provided",
    "strengthSummary": "2-3 sentences on what this location already has going for it before any marketing investment",
    "immediateOpportunity": "The single most important thing this owner should do in the next 7 days"
  },
  "locationSummary": {
    "headline": "One sharp specific sentence capturing this location's biggest market opportunity",
    "overview": "3-4 sentence narrative grounded in actual demographics and competitive data",
    "opportunityScore": 85,
    "topOpportunity": "The single highest-revenue opportunity based on what the data shows"
  },
  "marketResearch": {
    "demographics": {
      "headline": "One sentence on what the demographic profile means for this business",
      "renterPercentage": "XX%",
      "totalPopulation": "XX,XXX",
      "medianIncome": "$XX,XXX",
      "housingEra": "description",
      "keyInsight": "2-3 sentences on what these numbers mean for laundromat demand at this specific address"
    },
    "competitorAnalysis": {
      "summary": "3-4 sentences referencing specific competitor names, ratings, and weaknesses from reviews",
      "competitors": [
        {
          "name": "exact name",
          "address": "address",
          "distanceLabel": "X.X miles away",
          "rating": 4.2,
          "reviewCount": 180,
          "threat": "High/Medium/Low",
          "weakness": "Specific weakness from their actual review text — quote or reference real complaints",
          "opportunityAngle": "How this weakness creates an opening for this owner"
        }
      ],
      "competitiveAdvantage": "2-3 sentences on this owner's specific advantages over the named competitors"
    },
    "apartmentOpportunity": {
      "summary": "3-4 sentences referencing specific complex names, ratings, distances, and laundry frustration signals from reviews",
      "totalComplexes": 5,
      "estimatedHouseholds": 1000,
      "monthlyLaundrySpend": "$20,000",
      "topTargets": [
        {
          "name": "exact complex name",
          "address": "address",
          "distanceLabel": "X.X miles away",
          "priority": "High/Medium/Low",
          "rating": 3.0,
          "reviewCount": 197,
          "laundryFrustration": "Specific laundry complaint or frustration signal from reviews, or distance/proximity rationale",
          "reason": "Why this complex is a priority target — be specific"
        }
      ]
    },
    "reputationAudit": {
      "currentRating": "X.X stars",
      "reviewCount": "XXX reviews",
      "ratingVsMarket": "Direct comparison: how this owner's rating compares to every named competitor",
      "currentStrength": "2-3 sentences on what the rating means as a competitive asset",
      "recommendations": [
        "Specific tactical action 1 — e.g. how to respond to reviews, what to post, how to ask for reviews",
        "Specific tactical action 2",
        "Specific tactical action 3",
        "Specific tactical action 4"
      ]
    }
  },
  "marketingActionPlan": {
    "summary": "2-3 sentences referencing specific market conditions and the stated budget",
    "tactics": [
      {
        "rank": 1,
        "title": "Specific tactic name",
        "category": "Apartment Outreach / Commercial / Digital / In-Store",
        "description": "3-4 sentences with specific business names, distances, and actionable steps",
        "effort": "Low/Medium/High",
        "impact": "Low/Medium/High",
        "timeframe": "Week 1-2 / Month 1 / Ongoing",
        "estimatedMonthlyRevenue": "$X,XXX-X,XXX"
      }
    ],
    "budgetAllocation": {
      "total": "Must match stated budget range",
      "breakdown": [
        {"category": "name", "amount": "$XX", "rationale": "specific rationale for this market"}
      ]
    },
    "checklist90Day": {
      "week1_2": ["specific action naming real nearby businesses", "action 2", "action 3"],
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
      "phase2": "Month 1 — name under-1-mile canvassing targets by name and category",
      "phase3": "Month 2 — describe 1-2 mile targets"
    },
    "targets": [
      {
        "businessName": "exact name from research data",
        "category": "Hotel / Gym / Medical / Restaurant / Salon / Auto / Other",
        "address": "address",
        "distanceLabel": "X.X miles away",
        "priority": "High/Medium/Low",
        "estimatedMonthlyRevenue": "$XXX-XXX",
        "pitchAngle": "Specific pitch referencing this business type and laundry needs — use review signals if available",
        "bestApproachTime": "When and how to approach this specific business"
      }
    ]
  },
  "collateral": {
    "onePager": {
      "headline": "Compelling commercial headline specific to this location",
      "subheadline": "Supporting line referencing actual strengths",
      "bulletPoints": ["benefit with specific detail", "benefit 2", "benefit 3", "benefit 4"],
      "callToAction": "Specific CTA",
      "contactPrompt": "How to reach out"
    },
    "doorHanger": {
      "headline": "Headline referencing proximity to the closest apartment complexes",
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

    return res.status(400).json({ error: 'Unknown request type: ' + type });

  } catch(err) {
    return res.status(500).json({ error: { message: err.message, stack: err.stack } });
  }
};
