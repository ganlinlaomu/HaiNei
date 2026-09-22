# Friend List Synchronization Fix

## Problem Description

When users added or removed friends in the Friends page, these changes were not immediately reflected in other parts of the application that use the friend list:

1. **Home page subscriptions**: The Home page continued subscribing to messages from the old friend list, meaning:
   - Newly added friends' messages would not appear in the feed
   - Removed friends' messages would still be fetched (wasting resources)

2. **PostEditor recipient selection**: This was already working correctly due to reactive computed properties

## Root Cause

The issue was in `src/views/Home.vue`:
- The `friendSet` (Set of friend pubkeys) was created once during the initial subscription in `startSub()`
- This set was then reused for all subsequent subscriptions and backfills
- When friends were added or removed via the Friends page, the Home page was not notified and continued using the stale friend list

## Solution

Added a Vue watcher in `Home.vue` that monitors the `friends.version` field from the Pinia store:

```typescript
// Watch for changes to friend list (add/remove) and restart subscriptions
// This ensures that when friends are added or removed, the subscription
// automatically updates to include/exclude them
watch(() => friends.version, (newVersion, oldVersion) => {
  // Only restart if this is not the initial load
  if (oldVersion !== undefined && !isInitialLoad.value) {
    logger.info(`好友列表版本变化 (${oldVersion} -> ${newVersion})，重新启动订阅`);
    startSub().catch(e => logger.error('Failed to restart subscription after friends change', e));
  }
});
```

## How It Works

1. **Friends Store Versioning**: The `useFriendsStore` has a `version` field that is incremented whenever:
   - A friend is added (`add()` method)
   - A friend is removed (`remove()` method)
   - A friend is updated (`update()` method)

2. **Automatic Subscription Restart**: When the version changes, the watcher triggers and:
   - Logs the version change for debugging
   - Calls `startSub()` to restart the subscription process
   - This rebuilds the `friendSet` with the current friend list
   - Closes old subscriptions and creates new ones with the updated friend set

3. **Initial Load Protection**: The watcher checks `oldVersion !== undefined` and `!isInitialLoad.value` to avoid triggering during the initial page load

## Why PostEditor Already Works

The PostEditor and PostEditorModal components already use reactive computed properties:

```typescript
const groups = computed(() => {
  const list = friends.list || [];
  // ... compute groups from friend list
});

const recipients = computed(() => {
  const list = friends.list || [];
  // ... compute recipients from friend list and selections
});
```

Since Pinia stores are reactive in Vue 3, these computed properties automatically re-evaluate when `friends.list` changes, so no additional watchers were needed.

## Testing Instructions

### Manual Testing

1. **Add a New Friend**:
   ```
   - Go to Friends page
   - Click the "+" button
   - Add a new friend with pubkey and nickname
   - Navigate back to Home page
   - Check browser console: should see log "好友列表版本变化 (X -> Y)，重新启动订阅"
   - Verify that messages from the new friend appear in the feed
   ```

2. **Remove a Friend**:
   ```
   - Go to Friends page
   - Click the delete button (🗑) for a friend
   - Confirm deletion
   - Navigate back to Home page
   - Check browser console: should see log "好友列表版本变化 (X -> Y)，重新启动订阅"
   - Verify that messages from the removed friend no longer appear in new fetches
   ```

3. **PostEditor Recipient Selection**:
   ```
   - Go to Friends page and add a friend with a new group tag (e.g., "测试组")
   - Navigate to PostEditor (click "+" button in bottom nav)
   - Verify that the new group appears in the recipient selection chips
   - Verify that the friend count updates correctly
   ```

### Expected Behavior

- **Logs**: When a friend is added/removed, you should see these logs in the browser console:
  ```
  好友列表版本变化 (X -> Y)，重新启动订阅
  开始订阅流程
  好友列表加载完成: N 个好友
  准备订阅 N 个作者（包括自己）
  ```

- **Subscriptions**: The real-time subscription filters should include the updated friend list
- **Backfill**: When returning to Home page after adding a friend, the backfill process should fetch their historical messages
- **UI Updates**: PostEditor should immediately show the updated friend list and groups

## Performance Considerations

- **Subscription Restart Overhead**: Restarting subscriptions when friends change is a relatively lightweight operation:
  - Only occurs when friends are actually added/removed (not on every page visit)
  - Uses the same optimized subscription logic as initial page load
  - Properly closes old subscriptions before creating new ones to avoid leaks

- **No Impact on PostEditor**: PostEditor components don't need to restart anything, they simply react to store changes through Vue's reactivity system

## Files Changed

- `src/views/Home.vue`: Added watcher for `friends.version` (10 lines added)

## Related Code

- `src/stores/friends.ts`: Friend store with `version` field and add/remove/update methods
- `src/components/PostEditorModal.vue`: Uses reactive computed properties (already working)
- `src/components/PostEditorModal.vue`: Uses reactive computed properties (already working)
