# New Features - Happy New Years 🎉

This document describes the new features added to the HaiNei (海内) application.

## Feature 1: Friend Group Selection with Autocomplete

### Overview
Enhanced the friend management system with an intelligent autocomplete dropdown for group selection. Users can now easily organize friends into groups with a smooth, user-friendly interface.

### Location
**Friends Page (朋友) → Add/Edit Friend Modal → Group Tag Field (分组标签)**

### Features
- ✅ **Autocomplete Dropdown**: Shows existing groups as you type
- ✅ **Keyboard Navigation**: Use ↑/↓ arrow keys to navigate, Enter to select
- ✅ **Real-time Filtering**: Groups are filtered based on input
- ✅ **Create New Groups**: Simply type a new name to create a group on-the-fly
- ✅ **Visual Feedback**: Highlighted items and hover states
- ✅ **Smart Suggestions**: Groups sorted alphabetically in Chinese (zh-CN locale)

### How to Use

#### Adding a Friend with Group Selection
1. Navigate to the Friends page (朋友)
2. Click the **"+"** button to open the add friend modal
3. Fill in the friend's public key (hex or npub format)
4. Enter a nickname for the friend
5. In the **"分组标签"** (Group Tag) field:
   - Start typing to see existing groups
   - Use arrow keys to navigate suggestions
   - Press Enter or click to select a group
   - Or type a completely new name to create a new group
6. Click **"保存"** (Save) to add the friend

#### Editing Friend's Group
1. Click the edit button (✎) on any friend
2. Modify the group field using the autocomplete
3. Save changes

### Technical Implementation
- Uses Vue.js computed properties for reactive filtering
- Implements keyboard event handlers for navigation
- Blur event handling with delay for smooth UX
- CSS transitions for dropdown animations
- Stores groups in the existing friend data structure

---

## Feature 2: Video Support in Posts

### Overview
Added comprehensive video support to posts, allowing users to share videos from multiple sources including uploads, YouTube, Vimeo, and direct video links. Features lazy loading for optimal performance and bandwidth usage.

### Location
**Post Editor (发帖) → Video Upload/URL Input**  
**Home Feed (好友动态) → Video Player Component**

### Features
- ✅ **Video File Upload**: Upload mp4, webm, ogg files via Blossom
- ✅ **Video URL Support**: Paste links from YouTube, Vimeo, or direct URLs
- ✅ **Auto-detection**: Automatically identifies video provider
- ✅ **Lazy Loading**: Videos load only when user clicks play button
- ✅ **Poster Preview**: Shows attractive preview with provider info
- ✅ **Embedded Players**: YouTube and Vimeo videos use native embeds
- ✅ **HTML5 Video**: Direct video URLs use native HTML5 player
- ✅ **Progress Indicator**: Shows upload progress for video files

### Supported Video Sources

#### 1. YouTube Videos
- Paste any YouTube URL (youtube.com or youtu.be)
- Automatically extracts video ID
- Creates optimized embed URL
- Example: `https://www.youtube.com/watch?v=VIDEO_ID`

#### 2. Vimeo Videos
- Paste any Vimeo URL
- Automatically extracts video ID
- Creates player embed URL
- Example: `https://vimeo.com/VIDEO_ID`

#### 3. Direct Video URLs
- Supports .mp4, .webm, .ogg formats
- Uses HTML5 video player
- Example: `https://example.com/video.mp4`

#### 4. Video File Upload
- Upload from device using Blossom infrastructure
- Same security and encryption as image uploads
- Supports common video formats

### How to Use

#### Adding a Video to a Post
1. Click the **"+"** button to create a new post
2. **Option A - Upload Video File:**
   - Click **"上传视频"** (Upload Video) button
   - Select video file from device
   - Wait for upload progress to complete
   
3. **Option B - Paste Video URL:**
   - Paste video URL in the input field
   - URL can be YouTube, Vimeo, or direct link
   - Click outside the field or press Tab to validate
   
4. Preview appears showing:
   - Video provider badge (YouTube, Vimeo, etc.)
   - Play icon
   - URL information
   
5. Optionally add text content
6. Select recipients (friends or groups)
7. Click **"发送"** (Send) to publish

#### Viewing Videos in Feed
1. Videos appear in the feed with a poster/thumbnail
2. Shows provider badge and play button
3. Click the **play button** to load and watch
4. Video loads in appropriate player:
   - YouTube/Vimeo: iframe embed
   - Direct URLs: HTML5 video player
   - Uploaded videos: HTML5 video player

#### Removing a Video
- Click the **"✕"** button on video preview before sending
- Or use the clear button (✕) on the URL input field

### Technical Implementation

#### Video Metadata Format
Videos are stored in post content using a structured JSON format:
```
[video:{"type":"video","url":"https://...","provider":"YouTube","embedUrl":"https://..."}]
```

This format:
- ✅ Is easily parseable
- ✅ Prevents XSS attacks
- ✅ Maintains provider information
- ✅ Stores both original and embed URLs

#### Components

**PostEditorModal.vue**
- Video URL input with validation
- Video file upload handling
- Provider detection logic
- Preview generation

**VideoPlayer.vue**
- Lazy loading implementation
- Poster/thumbnail display
- iframe generation for embeds
- HTML5 video element for direct URLs
- Keyboard accessible (Enter key support)

**Home.vue**
- Video content parsing
- VideoPlayer component integration
- Text filtering (removes video metadata)

#### Security Features
- ✅ URL validation before parsing
- ✅ JSON structure prevents code injection
- ✅ Lazy loading prevents auto-execution
- ✅ iframe sandbox attributes for security
- ✅ No eval() or dynamic code execution

---

## Performance Considerations

### Lazy Loading
Videos use lazy loading to:
- Reduce initial page load time
- Save bandwidth for users
- Prevent auto-play issues
- Allow user control over data usage

### Upload Optimization
Video uploads through Blossom:
- Show progress feedback
- Support large files
- Use existing authentication
- Maintain encryption standards

---

## Browser Compatibility

### Supported Browsers
- ✅ Chrome/Edge (Chromium-based)
- ✅ Firefox
- ✅ Safari (Desktop and iOS)
- ✅ Mobile browsers (Chrome, Safari, Firefox)

### Video Format Support
Depends on browser's HTML5 video support:
- **mp4**: All modern browsers
- **webm**: Chrome, Firefox, Edge
- **ogg**: Firefox, Chrome

---

## Future Enhancements

Possible improvements for future releases:
- [ ] Video thumbnail generation for uploads
- [ ] HLS support for adaptive streaming
- [ ] Video compression before upload
- [ ] Multiple video support per post
- [ ] Video playlists
- [ ] Picture-in-picture mode
- [ ] Subtitle support
- [ ] Video trimming tool

---

## Troubleshooting

### Video Won't Load
1. Check internet connection
2. Verify video URL is accessible
3. Try different video source
4. Check browser console for errors

### Upload Fails
1. Check Blossom configuration in Settings
2. Verify video file size and format
3. Check network connection
4. Ensure login credentials are valid

### Autocomplete Not Showing
1. Ensure friends exist with groups assigned
2. Clear browser cache
3. Reload the page
4. Check browser console for errors

---

## API / Data Structure

### Friend Object with Group
```typescript
{
  pubkey: string;
  name: string;
  groups?: string[];  // New: array of group names
  group?: string;     // Legacy: single group (for backward compatibility)
  note?: string;
}
```

### Video Metadata Object
```typescript
{
  type: 'video';
  url: string;           // Original URL
  provider: string;      // 'YouTube' | 'Vimeo' | 'Direct' | 'Hosted' | 'External'
  embedUrl?: string;     // Embed/player URL
}
```

---

## Development Notes

### Constants
Video metadata format constants are defined for consistency:
```typescript
const VIDEO_METADATA_PREFIX = '[video:';
const VIDEO_METADATA_SUFFIX = ']';
```

### Regex Patterns
- Uses `match()` instead of `exec()` to avoid stateful behavior
- Global flag maintained for replacing all occurrences
- Tested with various URL formats

### Testing
- Manual testing with YouTube, Vimeo, direct URLs
- Browser compatibility verified
- Keyboard navigation tested
- Mobile responsiveness confirmed

---

## Credits

Implemented as part of the "Happy New Years" feature update for the HaiNei (海内) closed community PWA.

**Technologies Used:**
- Vue.js 3 + TypeScript
- Vite build tool
- Nostr protocol for messaging
- Blossom for file uploads
- Dexie for local storage

---

For questions or issues, please open an issue on the GitHub repository.
