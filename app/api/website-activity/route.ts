import { NextRequest, NextResponse } from "next/server";
import { REPS } from "../../../config/reps";
import {
  fetchWebsiteActivityForDomain,
  getDateDaysAgo,
  getCurrentDate,
} from "../../../lib/factors/client";
import type {
  AccountJourneyResponse,
  EnhancedUserTimeline,
  WebsiteActivityRequest,
} from "../../../lib/factors/types";

/**
 * API endpoint to fetch website activity for a rep's assigned companies.
 * 
 * This endpoint:
 * 1. Validates the rep exists in the tracked roster
 * 2. Fetches website activity from Factors API for the rep's assigned companies
 * 3. Returns enhanced data with parsed properties and formatted timestamps
 * 
 * GET /api/website-activity?owner_id=<hubspot_owner_id>&days=<number>
 * 
 * Query Parameters:
 * - owner_id (required): The HubSpot owner ID of the rep
 * - days (optional): Number of days to look back (default: 2)
 */

export const dynamic = "force-dynamic";

// In-memory cache for company domains per rep (to avoid repeated lookups)
// This would ideally come from a database or config, but for now we'll use a simple mapping
// based on the rep's assigned companies from HubSpot
const REP_COMPANY_DOMAINS: Record<string, string[]> = {
  // This mapping should be populated from actual data
  // For now, we'll use a placeholder that can be extended
  // Format: owner_id -> array of company domains
};

/**
 * Get company domains assigned to a rep.
 * In production, this should query HubSpot or a local database.
 * For now, we'll use the rep's name as a domain fallback.
 */
async function getCompanyDomainsForRep(ownerId: string): Promise<string[]> {
  // Check if we have cached domains for this rep
  if (REP_COMPANY_DOMAINS[ownerId] && REP_COMPANY_DOMAINS[ownerId].length > 0) {
    return REP_COMPANY_DOMAINS[ownerId];
  }
  
  // Fallback: Use a generic domain based on rep name
  // In production, this should query the actual assigned companies
  const repName = REPS[ownerId];
  if (repName) {
    // Convert name to a domain-like format
    const domain = repName.toLowerCase().replace(/\s+/g, "-") + ".com";
    return [domain];
  }
  
  // Ultimate fallback - use a test domain
  return ["test-company.com"];
}

/**
 * Fetch website activity for all companies assigned to a rep
 */
async function fetchActivityForRepCompanies(
  ownerId: string,
  days: number = 2
): Promise<{
  owner_name: string;
  companies: Array<{
    domain: string;
    timelines: EnhancedUserTimeline[];
    error?: string;
  }>;
  time_range: { from: string; to: string };
}> {
  const ownerName = REPS[ownerId] || `Rep ${ownerId}`;
  const domains = await getCompanyDomainsForRep(ownerId);
  
  const fromDate = getDateDaysAgo(days);
  const toDate = getCurrentDate();
  
  const results = await Promise.all(
    domains.map(async (domain) => {
      try {
        const timelines = await fetchWebsiteActivityForDomain(domain, days);
        return {
          domain,
          timelines,
        };
      } catch (error) {
        return {
          domain,
          timelines: [],
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    })
  );
  
  return {
    owner_name: ownerName,
    companies: results,
    time_range: { from: fromDate, to: toDate },
  };
}

/**
 * Main GET handler
 */
export async function GET(
  req: NextRequest,
  // No path params for this route
) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const ownerId = searchParams.get("owner_id");
    const daysParam = searchParams.get("days");
    
    // Validate required parameters
    if (!ownerId) {
      return NextResponse.json(
        { error: "owner_id parameter is required" },
        { status: 400 }
      );
    }
    
    // Validate the rep exists
    if (!REPS[ownerId]) {
      return NextResponse.json(
        { error: "Unknown rep - not in tracked roster" },
        { status: 404 }
      );
    }
    
    // Parse days parameter (default: 2)
    const days = daysParam ? Math.max(1, Math.min(30, parseInt(daysParam, 10))) : 2;
    
    // Fetch activity for the rep's companies
    const result = await fetchActivityForRepCompanies(ownerId, days);
    
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("Website activity API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

/**
 * POST handler for batch requests (optional)
 * 
 * This allows fetching activity for multiple reps at once.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { owner_ids, days = 2 } = body as {
      owner_ids: string[];
      days?: number;
    };
    
    if (!owner_ids || !Array.isArray(owner_ids)) {
      return NextResponse.json(
        { error: "owner_ids array is required" },
        { status: 400 }
      );
    }
    
    // Validate all owner IDs
    const validOwnerIds = owner_ids.filter((id) => REPS[id]);
    const invalidOwnerIds = owner_ids.filter((id) => !REPS[id]);
    
    if (invalidOwnerIds.length > 0) {
      return NextResponse.json(
        {
          error: "Some owner IDs are not in the tracked roster",
          invalid_owner_ids: invalidOwnerIds,
        },
        { status: 400 }
      );
    }
    
    // Fetch activity for all valid reps
    const results = await Promise.all(
      validOwnerIds.map((ownerId) => fetchActivityForRepCompanies(ownerId, days))
    );
    
    return NextResponse.json({
      success: true,
      results,
    });
  } catch (error) {
    console.error("Website activity batch API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
