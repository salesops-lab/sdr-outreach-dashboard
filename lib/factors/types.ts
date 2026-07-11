/**
 * Types for the Factors Account Journey API
 * API Documentation: https://api.factors.ai/open/v1/account/{account_domain}/journey
 */

/**
 * UserActivity represents a single event/action performed by a user.
 */
export interface UserActivity {
  event_id: string;
  event_name: string;
  event_type: string;
  timestamp: number; // Unix timestamp in seconds
  properties: string; // JSONB string - JSON string containing event properties
  display_name: string;
  alias_name: string;
  icon: string;
}

/**
 * UserTimeline represents a user and their activities within a timeframe.
 */
export interface UserTimeline {
  user_id: string;
  is_anonymous: boolean;
  user_name: string;
  user_properties: string; // JSONB string - JSON string containing user properties
  filtered_user_properties: Record<string, unknown>;
  user_activities: UserActivity[];
  user_last_event_at: string; // ISO 8601 timestamp
  extra_prop: string;
}

/**
 * Response from the Factors Account Journey API
 */
export type AccountJourneyResponse = UserTimeline[];

/**
 * Parameters for fetching account journey data
 */
export interface AccountJourneyParams {
  account_domain: string;
  from?: string; // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.ffffff
  to?: string; // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.ffffff
  event_name?: string; // case-insensitive substring match
  user_name?: string; // case-insensitive substring match
}

/**
 * Parsed user properties from the JSONB string
 */
export interface ParsedUserProperties {
  email?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Parsed event properties from the JSONB string
 */
export interface ParsedEventProperties {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  $page_url?: string;
  $is_page_view?: boolean;
  duration?: number;
  [key: string]: unknown;
}

/**
 * Enhanced activity with parsed properties
 */
export interface EnhancedUserActivity extends UserActivity {
  parsed_properties: ParsedEventProperties;
  formatted_timestamp: string;
  formatted_date: string;
  formatted_time: string;
}

/**
 * Enhanced timeline with parsed user properties
 */
export interface EnhancedUserTimeline extends UserTimeline {
  parsed_user_properties: ParsedUserProperties;
  enhanced_activities: EnhancedUserActivity[];
}

/**
 * Request parameters for the website activity feature
 */
export interface WebsiteActivityRequest {
  owner_id: string; // The rep's owner ID (HubSpot owner ID)
  owner_name: string; // The rep's display name
  days?: number; // Number of days to look back (default: 2)
}

/**
 * Response for website activity feature
 */
export interface WebsiteActivityResponse {
  success: boolean;
  data?: AccountJourneyResponse;
  error?: string;
  owner_name: string;
  time_range: {
    from: string;
    to: string;
  };
}
