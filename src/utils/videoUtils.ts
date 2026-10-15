/**
 * Utility functions for parsing and handling video URLs
 */
import { isEncryptedVideoRef } from './encryptedVideoRef';

export interface VideoData {
  type: 'video';
  url: string;
  provider: string;
  embedUrl?: string;
  thumbnail?: string;
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const YOUTUBE_EMBED = /^https:\/\/www\.youtube\.com\/embed\/[a-zA-Z0-9_-]{11}$/;
const VIMEO_EMBED = /^https:\/\/player\.vimeo\.com\/video\/\d+$/;

/**
 * Render-time guard for VideoPlayer (defense in depth): iframes only for the
 * two known embed origins, every other URL must be https.
 */
export function safeVideoEmbed(video: VideoData) {
  const embed = typeof video.embedUrl === 'string' ? video.embedUrl : '';
  const iframeUrl = (video.provider === 'YouTube' && YOUTUBE_EMBED.test(embed))
    || (video.provider === 'Vimeo' && VIMEO_EMBED.test(embed))
    ? embed
    : undefined;
  return {
    iframeUrl,
    mediaUrl: !iframeUrl && isHttpsUrl(embed) ? embed : undefined,
    linkUrl: typeof video.url === 'string' && isHttpsUrl(video.url) ? video.url : undefined,
  };
}

// Video URL regex patterns (without global flag to avoid stateful behavior)
const YOUTUBE_URL_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
const VIMEO_URL_PATTERN = /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/i;
const DIRECT_VIDEO_PATTERN = /https?:\/\/[^\s]+\.(?:mp4|webm|ogg)(?:\?[^\s]*)?/i;

/**
 * Parse a video URL and return video metadata
 * @param url - The URL string to parse
 * @returns VideoData object or null if not a valid video URL
 */
export function parseVideoUrl(url: string): VideoData | null {
  if (!url || !url.trim()) return null;
  
  const trimmedUrl = url.trim();
  // Post content is peer-controlled. Only https links (and the app's own
  // encrypted references, handled by extractVideoData) may become a video:
  // a javascript:/data: URL in an iframe or link executes in the app origin.
  if (!isHttpsUrl(trimmedUrl)) return null;
  
  // Check for YouTube URLs
  const youtubeMatch = trimmedUrl.match(YOUTUBE_URL_PATTERN);
  if (youtubeMatch) {
    const videoId = youtubeMatch[1];
    return {
      type: 'video',
      url: trimmedUrl,
      provider: 'YouTube',
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
  }
  
  // Check for Vimeo URLs
  const vimeoMatch = trimmedUrl.match(VIMEO_URL_PATTERN);
  if (vimeoMatch) {
    const videoId = vimeoMatch[1];
    return {
      type: 'video',
      url: trimmedUrl,
      provider: 'Vimeo',
      embedUrl: `https://player.vimeo.com/video/${videoId}`
    };
  }
  
  // Check for direct video URLs (mp4, webm, ogg)
  const directMatch = trimmedUrl.match(DIRECT_VIDEO_PATTERN);
  if (directMatch) {
    return {
      type: 'video',
      url: trimmedUrl,
      provider: 'Direct',
      embedUrl: trimmedUrl
    };
  }
  
  // Valid https URL but not a recognized video platform - treat as external
  return {
    type: 'video',
    url: trimmedUrl,
    provider: 'External',
    embedUrl: trimmedUrl
  };
}

/**
 * Extract video data from content string
 * Supports both JSON format [video:{...}] and plain video URLs
 * @param content - The content string to search for video data
 * @returns VideoData object or null if no video found
 */
export function extractVideoData(content: string): VideoData | null {
  if (!content) return null;
  
  // First, check for structured video metadata format: [video:{json}]
  const videoDataRE = /\[video:(\{[^\]]+\})\]/;
  const match = content.match(videoDataRE);
  
  if (match && match[1]) {
    try {
      const videoData = JSON.parse(match[1]);
      if (videoData?.type === 'video' && typeof videoData.url === 'string') {
        // Trust only the url: provider/embedUrl/thumbnail are re-derived so
        // a forged block cannot smuggle an executable URL into an iframe.
        const url = videoData.url.trim();
        if (isEncryptedVideoRef(url)) {
          return { type: 'video', url, provider: 'Encrypted' };
        }
        return parseVideoUrl(url);
      }
    } catch (e) {
      console.error("Failed to parse video data:", e);
    }
    return null;
  }
  
  // Second, check for plain video URLs
  // Try YouTube
  const youtubeMatch = content.match(YOUTUBE_URL_PATTERN);
  if (youtubeMatch) {
    const videoId = youtubeMatch[1];
    return {
      type: 'video',
      url: youtubeMatch[0],
      provider: 'YouTube',
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
  }
  
  // Try Vimeo
  const vimeoMatch = content.match(VIMEO_URL_PATTERN);
  if (vimeoMatch) {
    const videoId = vimeoMatch[1];
    return {
      type: 'video',
      url: vimeoMatch[0],
      provider: 'Vimeo',
      embedUrl: `https://player.vimeo.com/video/${videoId}`
    };
  }
  
  // Try direct video URLs
  const directMatch = content.match(DIRECT_VIDEO_PATTERN);
  if (directMatch) {
    return {
      type: 'video',
      url: directMatch[0],
      provider: 'Direct',
      embedUrl: directMatch[0]
    };
  }
  
  return null;
}

/**
 * Get regex patterns for removing video URLs from text
 * These patterns use the global flag for replacement operations
 */
export function getVideoUrlRemovalPatterns() {
  return {
    videoDataPattern: /\[video:(\{[^\]]+\})\]/g,
    youtubePattern: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi,
    vimeoPattern: /(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/gi,
    directVideoPattern: /https?:\/\/[^\s]+\.(?:mp4|webm|ogg)(?:\?[^\s]*)?/gi
  };
}

/**
 * Extract YouTube video ID from embed URL
 * @param embedUrl - The YouTube embed URL
 * @returns Video ID or null
 */
export function extractYouTubeVideoId(embedUrl: string): string | null {
  if (!embedUrl) return null;
  const match = embedUrl.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Get YouTube thumbnail URL for a video ID
 * @param videoId - The YouTube video ID
 * @param quality - Thumbnail quality (default, hqdefault, mqdefault, sddefault, maxresdefault)
 * @returns Thumbnail URL
 */
export function getYouTubeThumbnail(videoId: string, quality: string = 'hqdefault'): string {
  return `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
}
