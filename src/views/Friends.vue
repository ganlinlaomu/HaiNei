<template>
  <div class="friends-container">
    <!-- Sync Status Bar -->
    <div v-if="friends.syncing" class="sync-status syncing">
      <span class="sync-icon">⟳</span> 同步中...
    </div>
    <div v-else-if="friends.syncError" class="sync-status error">
      <span class="sync-icon">⚠</span> 同步失败: {{ friends.syncError }}
    </div>
    <div v-else-if="friends.lastSyncTimestamp > 0 && showSyncSuccess" class="sync-status success" :class="{ 'fade-out': isFadingOut }">
      <span class="sync-icon">✓</span> 已同步
    </div>

    <!-- Friend List -->
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h3 style="margin: 0;">好友（{{ acceptedFriends.length }}）</h3>
        <button 
          class="btn-icon btn-add" 
          @click="startAdd"
          title="添加好友"
          aria-label="添加好友"
        >
          +
        </button>
      </div>
      <div v-if="acceptedFriends.length === 0" class="small">还没有已确认好友</div>
      <div class="list" v-else>
        <div v-for="f in acceptedFriends" :key="f.pubkey" class="friend-item">
          <div class="friend-info">
            <div><strong>{{ f.name }}</strong></div>
            <div class="small">
              <span v-if="f.groups && f.groups.length > 0">
                {{ f.groups[0] }}
              </span>
              <span v-else-if="f.group">{{ f.group }}</span>
              <span v-else>未分组</span>
            </div>
          </div>
          <div class="friend-actions">
            <button class="more-button" type="button" :aria-expanded="openFriendMenu === f.pubkey" :aria-label="`${f.name} 的更多操作`" @click="toggleFriendMenu(f.pubkey)">更多</button>
            <div v-if="openFriendMenu === f.pubkey" class="friend-menu">
              <button type="button" @click="startEdit(f); openFriendMenu = ''">编辑资料</button>
              <button type="button" class="danger" @click="confirmDelete(f); openFriendMenu = ''">删除好友</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="incoming-requests" class="card">
      <h3>收到的请求（{{ incomingRequests.length }}）</h3>
      <div v-if="incomingRequests.length === 0" class="small">暂无收到的好友请求</div>
      <div v-else class="list">
        <div v-for="request in incomingRequests" :key="request.peerPubkey" class="friend-item">
          <div class="friend-info">
            <strong>{{ contactName(request.peerPubkey) }}</strong>
            <div class="small">{{ request.peerPubkey.slice(0, 16) }}…</div>
          </div>
          <div class="friend-actions">
            <button class="btn request-accept" @click="acceptRequest(request.peerPubkey)">接受</button>
            <button class="btn btn-cancel" @click="rejectRequest(request.peerPubkey)">拒绝</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>已发送请求（{{ outgoingRequests.length }}）</h3>
      <div v-if="outgoingRequests.length === 0" class="small">暂无等待确认的请求</div>
      <div v-else class="list">
        <div v-for="request in outgoingRequests" :key="request.peerPubkey" class="friend-item">
          <div class="friend-info">
            <strong>{{ contactName(request.peerPubkey) }}</strong>
            <div class="small">等待对方接受</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for Add/Edit Friend -->
    <div v-if="showModal" class="modal-overlay" @click="closeModal">
      <div class="modal-content" @click.stop>
        <h3>{{ editMode ? '编辑好友' : '添加好友' }}</h3>
        
        <form @submit.prevent="saveForm">
          <div class="form-group">
            <label>好友公钥 <span class="required">*</span></label>
            <input 
              v-model="formData.pubkey" 
              class="input" 
              placeholder="hex key 或 npub key"
              :disabled="editMode"
              :class="{ 'input-disabled': editMode }"
            />
            <div class="small" style="margin-top: 4px;">支持 64 位 hex 格式或 npub 格式</div>
          </div>

          <div class="form-group">
            <label>昵称 <span class="required">*</span></label>
            <input 
              v-model="formData.name" 
              class="input" 
              placeholder="好友昵称"
              required
            />
          </div>

          <div class="form-group">
            <label>分组标签</label>
            <div class="autocomplete-wrapper">
              <input 
                v-model="formData.groupsInput" 
                class="input" 
                placeholder="如: 家人（输入新组名或从已有分组中选择）"
                @input="onGroupInput"
                @focus="showGroupSuggestions = true"
                @blur="onGroupBlur"
                @keydown.down.prevent="navigateSuggestions(1)"
                @keydown.up.prevent="navigateSuggestions(-1)"
                @keydown.enter.prevent="selectHighlightedSuggestion"
              />
              <div v-if="showGroupSuggestions && filteredGroups.length > 0" class="suggestions-dropdown">
                <div 
                  v-for="(group, idx) in filteredGroups" 
                  :key="group"
                  class="suggestion-item"
                  :class="{ 'highlighted': idx === highlightedIndex }"
                  @mousedown.prevent="selectGroup(group)"
                  @mouseenter="highlightedIndex = idx"
                >
                  {{ group }}
                </div>
              </div>
            </div>
            <div class="small" style="margin-top: 4px;">只能设置一个分组，输入新名称可创建新分组</div>
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-cancel" @click="closeModal">取消</button>
            <button type="submit" class="btn" :disabled="saving">
              {{ saving ? "保存中..." : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch, computed } from "vue";
import { useFriendsStore, Friend } from "@/stores/friends";
import { useUIStore } from "@/stores/ui";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { keyToHex } from "@/utils/format";
import { useNotificationsStore } from "@/stores/notifications";
import { useRoute } from "vue-router";

export default defineComponent({
  name: "Friends",
  setup() {
    const friends = useFriendsStore();
    const friendships = useFriendshipsStore();
    const ui = useUIStore();
    const keys = useKeyStore();
    const notifications = useNotificationsStore();
    const route = useRoute();

    const showModal = ref(false);
    const editMode = ref(false);
    const saving = ref(false);
    const openFriendMenu = ref("");
    const showSyncSuccess = ref(false);
    const isFadingOut = ref(false);
    let hideTimeout: ReturnType<typeof setTimeout> | null = null;
    let fadeTimeout: ReturnType<typeof setTimeout> | null = null;
    
    // Group autocomplete state
    const showGroupSuggestions = ref(false);
    const highlightedIndex = ref(-1);
    
    const formData = ref({
      pubkey: "",
      name: "",
      groupsInput: "",
      originalPubkey: "" // for edit mode
    });

    // Get all existing groups from friends list
    const existingGroups = computed(() => {
      const groupSet = new Set<string>();
      for (const friend of friends.list) {
        if (friend.groups && friend.groups.length > 0) {
          friend.groups.forEach(g => groupSet.add(g));
        } else if (friend.group) {
          groupSet.add(friend.group);
        }
      }
      return Array.from(groupSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    });
    const acceptedFriends = computed(() => friends.getAcceptedList(friendships.isAccepted));
    const incomingRequests = computed(() => friendships.getIncomingRequests());
    const outgoingRequests = computed(() => friendships.getOutgoingRequests());
    const contactName = (pubkey: string) => friends.list.find(friend => friend.pubkey === pubkey)?.name || `${pubkey.slice(0, 8)}…`;

    function toggleFriendMenu(pubkey: string) {
      openFriendMenu.value = openFriendMenu.value === pubkey ? "" : pubkey;
    }

    // Filter groups based on current input
    const filteredGroups = computed(() => {
      const input = formData.value.groupsInput.trim().toLowerCase();
      if (!input) return existingGroups.value;
      return existingGroups.value.filter(g => 
        g.toLowerCase().includes(input)
      );
    });

    // Watch for sync completion to show/hide success message
    watch(() => friends.lastSyncTimestamp, (newVal, oldVal) => {
      if (newVal > 0 && newVal !== oldVal && !friends.syncing && !friends.syncError) {
        // Clear any existing timeouts
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        if (fadeTimeout) {
          clearTimeout(fadeTimeout);
          fadeTimeout = null;
        }
        
        // Show the success message
        showSyncSuccess.value = true;
        isFadingOut.value = false;
        
        // Start fade-out after 3 seconds
        hideTimeout = setTimeout(() => {
          isFadingOut.value = true;
          // Hide completely after fade-out animation (0.5s)
          fadeTimeout = setTimeout(() => {
            showSyncSuccess.value = false;
            isFadingOut.value = false;
            fadeTimeout = null;
          }, 500);
          hideTimeout = null;
        }, 3000);
      }
    });

    onMounted(async () => {
      await friends.load();
      await friendships.load();
      if (route.query.section === "incoming") {
        document.getElementById("incoming-requests")?.scrollIntoView({ block: "start" });
      }
    });

    onBeforeUnmount(() => {
      // Clean up timeouts to prevent memory leaks
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      if (fadeTimeout) {
        clearTimeout(fadeTimeout);
        fadeTimeout = null;
      }
    });

    const startAdd = () => {
      if (!keys.isLoggedIn) {
        ui.addToast("请先登录", 2000, "error");
        return;
      }
      editMode.value = false;
      formData.value = {
        pubkey: "",
        name: "",
        groupsInput: "",
        originalPubkey: ""
      };
      showModal.value = true;
    };

    const startEdit = (friend: Friend) => {
      editMode.value = true;
      const groupStr = friend.groups && friend.groups.length > 0 
        ? friend.groups[0]
        : friend.group || "";
      
      formData.value = {
        pubkey: friend.pubkey,
        name: friend.name || "",
        groupsInput: groupStr,
        originalPubkey: friend.pubkey
      };
      showModal.value = true;
    };

    const closeModal = () => {
      showModal.value = false;
      formData.value = {
        pubkey: "",
        name: "",
        groupsInput: "",
        originalPubkey: ""
      };
    };

    const saveForm = async () => {
      if (!keys.isLoggedIn) {
        ui.addToast("请先登录", 2000, "error");
        return;
      }

      const nameVal = formData.value.name.trim();
      if (!nameVal) {
        ui.addToast("昵称为必填项", 2000, "error");
        return;
      }

      saving.value = true;
      try {
        if (editMode.value) {
          // Update existing friend
          const groupInput = formData.value.groupsInput.trim();
          const group = groupInput.length > 0 ? groupInput : undefined;
          
          const ok = friends.update(formData.value.originalPubkey, {
            name: nameVal,
            groups: group ? [group] : undefined,
            group: group
          });

          if (ok) {
            ui.addToast("好友信息已更新", 2000, "success");
            closeModal();
          } else {
            ui.addToast("更新失败", 2000, "error");
          }
        } else {
          // Add new friend
          const pkInput = formData.value.pubkey.trim();
          if (!pkInput) {
            ui.addToast("请输入好友公钥", 2000, "error");
            return;
          }

          const hexKey = keyToHex(pkInput);
          if (!hexKey) {
            ui.addToast("公钥格式错误，请输入有效的 hex 或 npub 格式公钥", 3000, "error");
            return;
          }

          const groupInput = formData.value.groupsInput.trim();
          const group = groupInput.length > 0 ? groupInput : undefined;

          await friendships.sendRequest(hexKey);
          await friends.load();
          const existing = friends.list.find(friend => friend.pubkey === hexKey);
          if (existing) friends.update(hexKey, { name: nameVal, groups: group ? [group] : undefined, group });
          else friends.add({ pubkey: hexKey, name: nameVal, groups: group ? [group] : undefined, group });
          ui.addToast("好友请求已发送，等待对方接受", 2400, "success");
          closeModal();
        }
      } catch (e) {
        console.error("Save friend error:", e);
        ui.addToast("操作失败", 2000, "error");
      } finally {
        saving.value = false;
      }
    };

    const confirmDelete = async (friend: Friend) => {
      if (confirm(`确定要删除好友 "${friend.name}" 吗？`)) {
        await friendships.removeFriend(friend.pubkey);
        const ok = friends.remove(friend.pubkey);
        if (ok) ui.addToast("已删除", 1500, "info");
        else ui.addToast("删除失败", 1500, "error");
      }
    };

    const acceptRequest = async (pubkey: string) => {
      try {
        await friendships.acceptRequest(pubkey);
        notifications.resolveFriendRequests(pubkey);
        ui.addToast("已接受好友请求", 1800, "success");
      } catch {
        ui.addToast("接受失败，请稍后重试", 2000, "error");
      }
    };

    const rejectRequest = async (pubkey: string) => {
      try {
        await friendships.rejectRequest(pubkey);
        notifications.resolveFriendRequests(pubkey);
        ui.addToast("已拒绝好友请求", 1500, "info");
      } catch {
        ui.addToast("拒绝失败，请稍后重试", 2000, "error");
      }
    };

    // Group autocomplete handlers
    const onGroupInput = () => {
      showGroupSuggestions.value = true;
      highlightedIndex.value = -1;
    };

    const onGroupBlur = () => {
      // Delay hiding to allow click on suggestion
      setTimeout(() => {
        showGroupSuggestions.value = false;
        highlightedIndex.value = -1;
      }, 200);
    };

    const selectGroup = (group: string) => {
      formData.value.groupsInput = group;
      showGroupSuggestions.value = false;
      highlightedIndex.value = -1;
    };

    const navigateSuggestions = (direction: number) => {
      if (!showGroupSuggestions.value || filteredGroups.value.length === 0) return;
      
      const maxIndex = filteredGroups.value.length - 1;
      highlightedIndex.value += direction;
      
      if (highlightedIndex.value < 0) {
        highlightedIndex.value = maxIndex;
      } else if (highlightedIndex.value > maxIndex) {
        highlightedIndex.value = 0;
      }
    };

    const selectHighlightedSuggestion = () => {
      if (highlightedIndex.value >= 0 && highlightedIndex.value < filteredGroups.value.length) {
        selectGroup(filteredGroups.value[highlightedIndex.value]);
      }
    };

    return {
      friends,
      acceptedFriends,
      incomingRequests,
      outgoingRequests,
      contactName,
      showModal,
      editMode,
      formData,
      saving,
      openFriendMenu,
      toggleFriendMenu,
      showSyncSuccess,
      isFadingOut,
      startAdd,
      startEdit,
      closeModal,
      saveForm,
      confirmDelete,
      acceptRequest,
      rejectRequest,
      // Group autocomplete
      showGroupSuggestions,
      filteredGroups,
      highlightedIndex,
      onGroupInput,
      onGroupBlur,
      selectGroup,
      navigateSuggestions,
      selectHighlightedSuggestion
    };
  }
});
</script>

<style scoped>
.friends-container {
  position: relative;
  /* Add top padding to prevent header from being pushed out of screen */
  padding-top: 12px;
  padding-bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
  /* Ensure proper spacing and prevent content overlap */
  min-height: 100vh;
}

.sync-status {
  padding: 10px 16px;
  margin-bottom: 12px;
  border-radius: 8px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: opacity 0.5s ease-out;
}

.sync-status.fade-out {
  opacity: 0;
}

.sync-status.syncing {
  background: #dbeafe;
  color: #1e40af;
}

.sync-status.success {
  background: #dcfce7;
  color: #15803d;
}

.sync-status.error {
  background: #fee2e2;
  color: #991b1b;
}

.sync-icon {
  font-size: 16px;
  font-weight: bold;
}

.friend-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 9px 4px;
  background: #fff;
  border-bottom: 1px solid #eef2f6;
}

.friend-info {
  flex: 1;
}

.friend-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  position: relative;
}
.more-button {
  min-width: 44px;
  min-height: 40px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}
.friend-menu {
  position: absolute;
  z-index: 20;
  top: 42px;
  right: 0;
  min-width: 120px;
  padding: 5px;
  display: grid;
  gap: 2px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
}
.friend-menu button {
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #334155;
  text-align: left;
  cursor: pointer;
}
.friend-menu button:hover { background: #f8fafc; }
.friend-menu button.danger { color: #dc2626; }

.btn {
  background: #1976d2;
  color: #fff;
  padding: 8px 12px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 14px;
}

.btn:hover {
  opacity: 0.9;
}

.btn-cancel {
  background: #6b7280;
}

.request-accept {
  background: #16a34a;
}

.btn-icon {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: all 0.2s;
  background: white;
}

.btn-add {
  width: calc(32px * 2 + 6px);
  height: 32px;
  color: #1976d2;
  border: 1px solid #1976d2;
  font-size: 20px;
  font-weight: 300;
  margin-right: 12px;
}

.btn-add:hover {
  background: #1976d2;
  color: white;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(25, 118, 210, 0.3);
}

.btn-edit {
  color: #3b82f6;
  border: 1px solid #3b82f6;
}

.btn-edit:hover {
  background: #3b82f6;
  color: white;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
}

.btn-delete {
  color: #ef4444;
  border: 1px solid #ef4444;
}

.btn-delete:hover {
  background: #ef4444;
  color: white;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
}

.modal-content {
  background: white;
  border-radius: 12px;
  padding: 24px;
  max-width: 500px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

.modal-content h3 {
  margin-top: 0;
  margin-bottom: 20px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #374151;
}

.required {
  color: #ef4444;
}

.input {
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  font-size: 14px;
  box-sizing: border-box;
}

.input:focus {
  outline: none;
  border-color: #1976d2;
  box-shadow: 0 0 0 3px rgba(25, 118, 210, 0.1);
}

.input-disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.small {
  font-size: 12px;
  color: #64748b;
}

.card {
  background: #fff;
  padding: 14px;
  border-radius: 12px;
  margin: 0 10px 10px;
  border: 1px solid #e8edf3;
  box-shadow: 0 2px 8px rgba(15,23,42,0.03);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 12px;
}

/* Autocomplete */
.autocomplete-wrapper {
  position: relative;
}

.suggestions-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #e5e7eb;
  border-top: none;
  border-radius: 0 0 8px 8px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 1000;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.suggestion-item {
  padding: 10px;
  cursor: pointer;
  transition: background-color 0.15s;
  font-size: 14px;
}

.suggestion-item:hover,
.suggestion-item.highlighted {
  background-color: #f3f4f6;
}

.suggestion-item:last-child {
  border-radius: 0 0 8px 8px;
}
</style>
