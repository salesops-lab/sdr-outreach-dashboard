/**
 * Factors API Client for Account Journey Data
 * 
 * This client provides methods to fetch website activity data from the Factors API.
 * API Key: ad9d0b20e949a90d3e6a6c2ba83c1ef2
 * 
 * Note: The API key will be rotated later as per user instructions.
 */

import {
  AccountJourneyParams,
  AccountJourneyResponse,
  EnhancedUserActivity,
  EnhancedUserTimeline,
  ParsedEventProperties,
  ParsedUserProperties,
  UserActivity,
  UserTimeline,
} from "./types";

const FACTORS_API_KEY = "ad9d0b20e949a90d3e6a6c2ba83c1ef2";
const FACTORS_API_BASE = "https://api.factors.ai/open/v1";

/**
 * Parse JSONB string safely
 */
function safeParseJson<T>(jsonString: string): T | Record<string, unknown> {
  try {
    if (!jsonString || jsonString === "{}" || jsonString === "null") {
      return {};
    }
    return JSON.parse(jsonString) as T;
  } catch {
    return {};
  }
}

/**
 * Parse user properties from JSONB string
 */
export function parseUserProperties(user_properties: string): ParsedUserProperties {
  const parsed = safeParseJson<Record<string, unknown>>(user_properties);
  return {
    email: (parsed.email || parsed.$email || parsed.Email) as string | undefined,
    name: (parsed.name || parsed.$name || parsed.Name) as string | undefined,
    ...parsed,
  };
}

/**
 * Parse event properties from JSONB string
 */
export function parseEventProperties(properties: string): ParsedEventProperties {
  const parsed = safeParseJson<Record<string, unknown>>(properties);
  return {
    utm_source: parsed.utm_source as string | undefined,
    utm_medium: parsed.utm_medium as string | undefined,
    utm_campaign: parsed.utm_campaign as string | undefined,
    $page_url: parsed.$page_url as string | undefined,
    $is_page_view: parsed.$is_page_view as boolean | undefined,
    duration: parsed.duration as number | undefined,
    ...parsed,
  };
}

/**
 * Format Unix timestamp to readable date/time strings
 */
export function formatTimestamp(timestamp: number): {
  formatted_timestamp: string;
  formatted_date: string;
  formatted_time: string;
} {
  const date = new Date(timestamp * 1000);
  
  // Format: "2024-01-15 14:30:00"
  const formatted_timestamp = date.toISOString().replace("T", " ").replace("Z", "");
  
  // Format date: "Jan 15, 2024"
  const formatted_date = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  
  // Format time: "2:30 PM"
  const formatted_time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  
  return { formatted_timestamp, formatted_date, formatted_time };
}

/**
 * Enhance a single activity with parsed properties and formatted timestamps
 */
export function enhanceActivity(activity: UserActivity): EnhancedUserActivity {
  const timestampInfo = formatTimestamp(activity.timestamp);
  
  return {
    ...activity,
    parsed_properties: parseEventProperties(activity.properties),
    ...timestampInfo,
  };
}

/**
 * Enhance a user timeline with parsed properties and enhanced activities
 */
export function enhanceTimeline(timeline: UserTimeline): EnhancedUserTimeline {
  return {
    ...timeline,
    parsed_user_properties: parseUserProperties(timeline.user_properties),
    enhanced_activities: timeline.user_activities.map(enhanceActivity),
  };
}

/**
 * Enhance all timelines in a response
 */
export function enhanceResponse(response: AccountJourneyResponse): EnhancedUserTimeline[] {
  return response.map(enhanceTimeline);
}

/**
 * Build URL for the Account Journey API
 */
function buildAccountJourneyUrl(params: AccountJourneyParams): string {
  const { account_domain, from, to, event_name, user_name } = params;
  
  let url = `${FACTORS_API_BASE}/account/${encodeURIComponent(account_domain)}/journey`;
  
  const queryParams: Record<string, string> = {};
  
  if (from) {
    queryParams.from = from;
  }
  if (to) {
    queryParams.to = to;
  }
  if (event_name) {
    queryParams.event_name = event_name;
  }
  if (user_name) {
    queryParams.user_name = user_name;
  }
  
  const queryString = new URLSearchParams(queryParams).toString();
  if (queryString) {
    url += `?${queryString}`;
  }
  
  return url;
}

/**
 * Fetch account journey data from Factors API
 */
export async function fetchAccountJourney(
  params: AccountJourneyParams
): Promise<AccountJourneyResponse> {
  const url = buildAccountJourneyUrl(params);
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${FACTORS_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Factors API error: ${response.status} ${response.statusText}\n${JSON.stringify(errorData)}`
    );
  }
  
  const data = await response.json();
  return data as AccountJourneyResponse;
}

/**
 * Fetch account journey data with enhancement (parsed properties, formatted timestamps)
 */
export async function fetchEnhancedAccountJourney(
  params: AccountJourneyParams
): Promise<EnhancedUserTimeline[]> {
  const response = await fetchAccountJourney(params);
  return enhanceResponse(response);
}

/**
 * Get date string in YYYY-MM-DD format for a given number of days ago
 */
export function getDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

/**
 * Get current date string in YYYY-MM-DD format
 */
export function getCurrentDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Fetch website activity for a specific account domain over the last N days
 */
export async function fetchWebsiteActivityForDomain(
  accountDomain: string,
  days: number = 2
): Promise<EnhancedUserTimeline[]> {
  const fromDate = getDateDaysAgo(days);
  const toDate = getCurrentDate();
  
  return fetchEnhancedAccountJourney({
    account_domain: accountDomain,
    from: fromDate,
    to: toDate,
  });
}

/**
 * Health check for Factors API connectivity
 */
export async function checkFactorsApiHealth(): Promise<boolean> {
  try {
    // Try a simple request with a known domain
    await fetchAccountJourney({
      account_domain: "factors.ai",
      from: getDateDaysAgo(1),
      to: getCurrentDate(),
    });
    return true;
  } catch {
    return false;
  }
}
