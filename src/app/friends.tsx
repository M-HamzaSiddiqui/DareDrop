import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DD } from '@/constants/dd-theme';
import { useAuth } from '@/lib/auth-context';
import {
  acceptFriendRequest,
  cancelFriendRequest,
  declineFriendRequest,
  fetchOrCreateUserProfile,
  fetchPendingFriendRequests,
  fetchUserFriends,
  lookupProfileByCode,
  normalizeFriendCode,
  removeFriend,
  sendFriendRequest,
  shareFriendCode,
  translateSocialError,
} from '@/lib/friends';
import {
  DbUserProfile,
  isSupabaseConfigured,
  PendingFriendRequest,
  PublicProfileLookup,
  UserFriend,
} from '@/lib/supabase';

type FriendsTab = 'friends' | 'requests' | 'add';

export default function FriendsScreen() {
  const insets = useSafeAreaInsets();
  const { isGuest, showAuthModal } = useAuth();

  const [activeTab, setActiveTab] = useState<FriendsTab>('friends');
  const [profile, setProfile] = useState<DbUserProfile | null>(null);
  const [friends, setFriends] = useState<UserFriend[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<PendingFriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<PendingFriendRequest[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured && !isGuest);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedToast, setCopiedToast] = useState<string | null>(null);

  // Add friend form state
  const [inputCode, setInputCode] = useState('');
  const [lookupResult, setLookupResult] = useState<PublicProfileLookup | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  // Action states for accept / decline / cancel / remove
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [removingFriendId, setRemovingFriendId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (isGuest || !isSupabaseConfigured) {
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const [userProfile, userFriends, requests] = await Promise.all([
        fetchOrCreateUserProfile().catch(() => null),
        fetchUserFriends().catch(() => []),
        fetchPendingFriendRequests().catch(() => ({ incoming: [], outgoing: [] })),
      ]);

      if (userProfile) setProfile(userProfile);
      setFriends(userFriends);
      setIncomingRequests(requests.incoming);
      setOutgoingRequests(requests.outgoing);
    } catch {
      // Graceful error state
    } finally {
      setRefreshing(false);
    }
  }, [isGuest]);

  useEffect(() => {
    let isMounted = true;
    if (isGuest || !isSupabaseConfigured) {
      return;
    }

    Promise.all([
      fetchOrCreateUserProfile().catch(() => null),
      fetchUserFriends().catch(() => []),
      fetchPendingFriendRequests().catch(() => ({ incoming: [], outgoing: [] })),
    ])
      .then(([userProfile, userFriends, requests]) => {
        if (!isMounted) return;
        if (userProfile) setProfile(userProfile);
        setFriends(userFriends);
        setIncomingRequests(requests.incoming);
        setOutgoingRequests(requests.outgoing);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isGuest]);

  const handleShareCode = async () => {
    if (!profile?.friend_code) return;
    const res = await shareFriendCode(profile.friend_code, profile.display_name);
    if (res.method === 'clipboard') {
      showToast('Friend code copied to clipboard!');
    }
  };

  const showToast = (msg: string) => {
    setCopiedToast(msg);
    setTimeout(() => setCopiedToast(null), 3000);
  };

  const handleLookup = async () => {
    setAddError(null);
    setAddSuccess(null);
    setLookupResult(null);

    const normalized = normalizeFriendCode(inputCode);
    if (!normalized) {
      setAddError('Please enter a valid 8-character friend code (e.g. DARE-XXXX-XXXX).');
      return;
    }

    setIsSearching(true);
    try {
      const found = await lookupProfileByCode(normalized);
      if (!found) {
        setAddError('No user found with that friend code. Please check and try again.');
      } else if (found.is_self) {
        setAddError('This is your own friend code!');
      } else {
        setLookupResult(found);
      }
    } catch (err: any) {
      setAddError(translateSocialError(err));
    } finally {
      setIsSearching(false);
    }
  };

  const handleSendRequest = async (targetCode: string) => {
    setIsSubmitting(true);
    setAddError(null);
    setAddSuccess(null);

    try {
      const result = await sendFriendRequest(targetCode);
      if (result.status === 'accepted') {
        setAddSuccess(`Connected! You and ${result.targetDisplayName} are now friends.`);
      } else {
        setAddSuccess(`Friend request sent to ${result.targetDisplayName}!`);
      }
      setInputCode('');
      setLookupResult(null);
      await loadData();
    } catch (err: any) {
      setAddError(translateSocialError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAcceptRequest = async (req: PendingFriendRequest) => {
    setProcessingRequestId(req.request_id);
    try {
      await acceptFriendRequest(req.request_id);
      showToast(`Connected with ${req.display_name}!`);
      await loadData();
    } catch (err: any) {
      Alert.alert('Error', translateSocialError(err));
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleDeclineRequest = async (req: PendingFriendRequest) => {
    setProcessingRequestId(req.request_id);
    try {
      await declineFriendRequest(req.request_id);
      await loadData();
    } catch (err: any) {
      Alert.alert('Error', translateSocialError(err));
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleCancelRequest = async (req: PendingFriendRequest) => {
    setProcessingRequestId(req.request_id);
    try {
      await cancelFriendRequest(req.request_id);
      await loadData();
    } catch (err: any) {
      Alert.alert('Error', translateSocialError(err));
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleRemoveFriend = (friend: UserFriend) => {
    Alert.alert(
      'Remove Friend',
      `Are you sure you want to remove ${friend.display_name} from your friends? You will no longer be able to invite them to private dares.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemovingFriendId(friend.friend_user_id);
            try {
              await removeFriend(friend.friend_user_id);
              showToast(`Removed ${friend.display_name}.`);
              await loadData();
            } catch (err: any) {
              Alert.alert('Error', translateSocialError(err));
            } finally {
              setRemovingFriendId(null);
            }
          },
        },
      ],
    );
  };

  const totalRequestsCount = incomingRequests.length;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + DD.s3 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Text style={styles.backButtonText}>←</Text>
        </Pressable>

        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Friends & Social</Text>
        </View>

        {profile?.friend_code ? (
          <Pressable
            onPress={handleShareCode}
            hitSlop={8}
            style={styles.shareHeaderBtn}
            accessibilityRole="button"
            accessibilityLabel="Share friend code">
            <Text style={styles.shareHeaderBtnText}>Share Code</Text>
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {/* Copied Toast */}
      {copiedToast && (
        <View style={styles.toastWrap}>
          <Text style={styles.toastText}>✓ {copiedToast}</Text>
        </View>
      )}

      {/* Offline / Supabase Not Connected Notice */}
      {!isSupabaseConfigured && (
        <View style={styles.offlineNotice}>
          <Text style={styles.offlineIcon}>⚠️</Text>
          <Text style={styles.offlineText}>
            Online connection required. Connect to DareDrop cloud to link with friends and send social dare invites.
          </Text>
        </View>
      )}

      {/* Friend Code Card */}
      {profile && (
        <View style={styles.codeCard}>
          <View style={styles.codeCardLeft}>
            <Text style={styles.codeCardLabel}>YOUR FRIEND CODE</Text>
            <Text style={styles.codeCardValue}>{profile.friend_code}</Text>
          </View>
          <View style={styles.codeCardActions}>
            <Pressable
              onPress={handleShareCode}
              style={({ pressed }) => [styles.copyBtn, pressed && { opacity: 0.8 }]}
              accessibilityRole="button"
              accessibilityLabel="Copy or share friend code">
              <Text style={styles.copyBtnText}>Copy & Share 🔗</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabsRow}>
        <Pressable
          onPress={() => setActiveTab('friends')}
          style={[styles.tabItem, activeTab === 'friends' && styles.tabItemActive]}>
          <Text style={[styles.tabItemText, activeTab === 'friends' && styles.tabItemTextActive]}>
            Friends ({friends.length})
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setActiveTab('requests')}
          style={[styles.tabItem, activeTab === 'requests' && styles.tabItemActive]}>
          <View style={styles.tabItemWithBadge}>
            <Text style={[styles.tabItemText, activeTab === 'requests' && styles.tabItemTextActive]}>
              Requests
            </Text>
            {totalRequestsCount > 0 && (
              <View style={styles.requestsBadge}>
                <Text style={styles.requestsBadgeText}>{totalRequestsCount}</Text>
              </View>
            )}
          </View>
        </Pressable>

        <Pressable
          onPress={() => setActiveTab('add')}
          style={[styles.tabItem, activeTab === 'add' && styles.tabItemActive]}>
          <Text style={[styles.tabItemText, activeTab === 'add' && styles.tabItemTextActive]}>
            + Add Friend
          </Text>
        </Pressable>
      </View>

      {/* Content Area */}
      {isGuest ? (
        <View style={styles.centered}>
          <View style={styles.emptyIconWrap}>
            <Text style={styles.emptyIcon}>🔒</Text>
          </View>
          <Text style={styles.emptyTitle}>Sign in to connect with friends</Text>
          <Text style={[styles.emptySub, { marginHorizontal: DD.s4, textAlign: 'center' }]}>
            Create an account or sign in to share your friend code, add friends, and challenge each other.
          </Text>
          <Pressable
            onPress={() =>
              showAuthModal({
                title: 'Sign In to Connect with Friends',
                description: 'Create an account to add friends, share codes, and challenge each other.',
              })
            }
            style={({ pressed }) => [styles.emptyAddBtn, { marginTop: DD.s4 }, pressed && { opacity: 0.8 }]}>
            <Text style={styles.emptyAddBtnText}>Sign In / Register</Text>
          </Pressable>
        </View>
      ) : loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={DD.lime} size="large" />
          <Text style={styles.loadingText}>Loading social contacts...</Text>
        </View>
      ) : activeTab === 'friends' ? (
        /* FRIENDS LIST TAB */
        <FlatList
          data={friends}
          keyExtractor={(item) => item.friendship_id}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 40 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={loadData}
              tintColor={DD.lime}
              colors={[DD.lime]}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIconWrap}>
                <Text style={styles.emptyIcon}>🤝</Text>
              </View>
              <Text style={styles.emptyTitle}>No friends added yet</Text>
              <Text style={styles.emptySub}>
                Share your unique Friend Code with someone or enter their code in &ldquo;+ Add Friend&rdquo; to connect!
              </Text>
              <Pressable
                onPress={() => setActiveTab('add')}
                style={({ pressed }) => [styles.emptyAddBtn, pressed && { opacity: 0.8 }]}>
                <Text style={styles.emptyAddBtnText}>+ Add a Friend Now</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.friendCard}>
              <View style={styles.friendAvatarWrap}>
                <Text style={styles.friendAvatar}>{item.avatar_emoji || '🦁'}</Text>
              </View>
              <View style={styles.friendInfo}>
                <Text style={styles.friendName}>{item.display_name}</Text>
                <Text style={styles.friendCode}>{item.friend_code}</Text>
              </View>
              <Pressable
                onPress={() => handleRemoveFriend(item)}
                disabled={removingFriendId === item.friend_user_id}
                style={({ pressed }) => [styles.removeFriendBtn, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.display_name}`}>
                {removingFriendId === item.friend_user_id ? (
                  <ActivityIndicator size="small" color={DD.textMuted} />
                ) : (
                  <Text style={styles.removeFriendBtnText}>Remove</Text>
                )}
              </Pressable>
            </View>
          )}
        />
      ) : activeTab === 'requests' ? (
        /* REQUESTS TAB */
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 40 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={loadData}
              tintColor={DD.lime}
              colors={[DD.lime]}
            />
          }>
          {/* Incoming Section */}
          <Text style={styles.sectionHeading}>
            INCOMING REQUESTS ({incomingRequests.length})
          </Text>
          {incomingRequests.length === 0 ? (
            <View style={styles.requestEmptyCard}>
              <Text style={styles.requestEmptyText}>No incoming requests</Text>
            </View>
          ) : (
            incomingRequests.map((req) => (
              <View key={req.request_id} style={styles.requestCard}>
                <View style={styles.friendAvatarWrap}>
                  <Text style={styles.friendAvatar}>{req.avatar_emoji || '🦁'}</Text>
                </View>
                <View style={styles.friendInfo}>
                  <Text style={styles.friendName}>{req.display_name}</Text>
                  <Text style={styles.friendCode}>{req.friend_code}</Text>
                </View>
                <View style={styles.requestActions}>
                  <Pressable
                    onPress={() => handleAcceptRequest(req)}
                    disabled={processingRequestId === req.request_id}
                    style={({ pressed }) => [styles.acceptBtn, pressed && { opacity: 0.8 }]}>
                    {processingRequestId === req.request_id ? (
                      <ActivityIndicator size="small" color={DD.bg} />
                    ) : (
                      <Text style={styles.acceptBtnText}>Accept</Text>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => handleDeclineRequest(req)}
                    disabled={processingRequestId === req.request_id}
                    style={({ pressed }) => [styles.declineBtn, pressed && { opacity: 0.8 }]}>
                    <Text style={styles.declineBtnText}>Decline</Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}

          {/* Outgoing Section */}
          <Text style={[styles.sectionHeading, { marginTop: DD.s5 }]}>
            OUTGOING REQUESTS ({outgoingRequests.length})
          </Text>
          {outgoingRequests.length === 0 ? (
            <View style={styles.requestEmptyCard}>
              <Text style={styles.requestEmptyText}>No outgoing requests</Text>
            </View>
          ) : (
            outgoingRequests.map((req) => (
              <View key={req.request_id} style={styles.requestCard}>
                <View style={styles.friendAvatarWrap}>
                  <Text style={styles.friendAvatar}>{req.avatar_emoji || '🦁'}</Text>
                </View>
                <View style={styles.friendInfo}>
                  <Text style={styles.friendName}>{req.display_name}</Text>
                  <Text style={styles.friendCode}>{req.friend_code}</Text>
                </View>
                <Pressable
                  onPress={() => handleCancelRequest(req)}
                  disabled={processingRequestId === req.request_id}
                  style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.8 }]}>
                  {processingRequestId === req.request_id ? (
                    <ActivityIndicator size="small" color={DD.textMuted} />
                  ) : (
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  )}
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>
      ) : (
        /* ADD FRIEND TAB */
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 40 }]}>
            <View style={styles.addCard}>
              <Text style={styles.addTitle}>Enter Friend Code</Text>
              <Text style={styles.addSub}>
                Ask your friend for their 8-character DareDrop code (format: DARE-XXXX-XXXX) to connect.
              </Text>

              <View style={styles.inputRow}>
                <TextInput
                  value={inputCode}
                  onChangeText={(text) => {
                    setInputCode(text);
                    setAddError(null);
                    setAddSuccess(null);
                    setLookupResult(null);
                  }}
                  placeholder="DARE-XXXX-XXXX"
                  placeholderTextColor={DD.textMuted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={14}
                  style={styles.codeInput}
                />
                <Pressable
                  onPress={handleLookup}
                  disabled={isSearching || !inputCode.trim()}
                  style={({ pressed }) => [
                    styles.lookupBtn,
                    (!inputCode.trim() || isSearching) && { opacity: 0.5 },
                    pressed && { opacity: 0.8 },
                  ]}>
                  {isSearching ? (
                    <ActivityIndicator size="small" color={DD.bg} />
                  ) : (
                    <Text style={styles.lookupBtnText}>Find</Text>
                  )}
                </Pressable>
              </View>

              {/* Error Callout */}
              {addError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>⚠️ {addError}</Text>
                </View>
              )}

              {/* Success Callout */}
              {addSuccess && (
                <View style={styles.successBox}>
                  <Text style={styles.successText}>✓ {addSuccess}</Text>
                </View>
              )}

              {/* Lookup Result Card */}
              {lookupResult && (
                <View style={styles.lookupResultCard}>
                  <View style={styles.lookupResultLeft}>
                    <Text style={styles.lookupResultAvatar}>{lookupResult.avatar_emoji || '🦁'}</Text>
                    <View>
                      <Text style={styles.lookupResultName}>{lookupResult.display_name}</Text>
                      <Text style={styles.lookupResultCode}>DareDrop User</Text>
                    </View>
                  </View>
                  {lookupResult.friendship_status === 'accepted' ? (
                    <View style={styles.alreadyFriendsBadge}>
                      <Text style={styles.alreadyFriendsText}>Already Friends ✓</Text>
                    </View>
                  ) : lookupResult.friendship_status === 'pending' ? (
                    <View style={styles.pendingBadge}>
                      <Text style={styles.pendingBadgeText}>Pending</Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={() => handleSendRequest(inputCode.trim())}
                      disabled={isSubmitting}
                      style={({ pressed }) => [styles.sendReqBtn, pressed && { opacity: 0.8 }]}>
                      {isSubmitting ? (
                        <ActivityIndicator size="small" color={DD.bg} />
                      ) : (
                        <Text style={styles.sendReqBtnText}>Send Request</Text>
                      )}
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: DD.s4,
    paddingBottom: DD.s3,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
    backgroundColor: DD.bgCard,
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: DD.bgElement,
  },
  backButtonText: {
    fontSize: 20,
    fontWeight: '700',
    color: DD.text,
  },
  headerTitleWrap: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.3,
  },
  shareHeaderBtn: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    backgroundColor: DD.lime,
  },
  shareHeaderBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.bg,
  },
  headerSpacer: {
    width: 36,
  },
  toastWrap: {
    position: 'absolute',
    top: 90,
    left: DD.s4,
    right: DD.s4,
    zIndex: 99,
    backgroundColor: DD.lime,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s4,
    borderRadius: DD.radiusMd,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 6,
  },
  toastText: {
    color: DD.bg,
    fontWeight: '800',
    fontSize: 13,
  },
  offlineNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#3A2510',
    borderColor: '#784C10',
    borderWidth: 1,
    margin: DD.s4,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    gap: DD.s2,
  },
  offlineIcon: {
    fontSize: 16,
  },
  offlineText: {
    flex: 1,
    fontSize: 12,
    color: '#FBD38D',
    lineHeight: 16,
  },
  codeCard: {
    marginHorizontal: DD.s4,
    marginTop: DD.s3,
    marginBottom: DD.s2,
    padding: DD.s4,
    borderRadius: DD.radiusLg,
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  codeCardLeft: {
    flex: 1,
  },
  codeCardLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: DD.textMuted,
    marginBottom: 4,
  },
  codeCardValue: {
    fontSize: 18,
    fontWeight: '900',
    color: DD.lime,
    letterSpacing: 0.5,
  },
  codeCardActions: {
    marginLeft: DD.s3,
  },
  copyBtn: {
    backgroundColor: DD.bgElement,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
  },
  copyBtnText: {
    color: DD.text,
    fontSize: 12,
    fontWeight: '700',
  },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: DD.s4,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
    backgroundColor: DD.bgCard,
  },
  tabItem: {
    paddingVertical: DD.s3,
    marginRight: DD.s5,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabItemActive: {
    borderBottomColor: DD.lime,
  },
  tabItemText: {
    fontSize: 14,
    fontWeight: '600',
    color: DD.textMuted,
  },
  tabItemTextActive: {
    color: DD.lime,
    fontWeight: '800',
  },
  tabItemWithBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  requestsBadge: {
    backgroundColor: DD.catFun,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
  },
  requestsBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
  },
  listContent: {
    padding: DD.s4,
  },
  scrollArea: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: DD.s6,
  },
  loadingText: {
    color: DD.textMuted,
    fontSize: 13,
    marginTop: DD.s3,
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: DD.s8,
    paddingHorizontal: DD.s4,
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: DD.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD.s3,
  },
  emptyIcon: {
    fontSize: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s2,
  },
  emptySub: {
    fontSize: 13,
    color: DD.textSub,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: DD.s5,
  },
  emptyAddBtn: {
    backgroundColor: DD.lime,
    paddingHorizontal: DD.s5,
    paddingVertical: DD.s3,
    borderRadius: DD.radiusPill,
  },
  emptyAddBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: DD.bg,
  },
  friendCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD.bgCard,
    padding: DD.s3,
    borderRadius: DD.radiusLg,
    borderWidth: 1,
    borderColor: DD.border,
    marginBottom: DD.s2,
  },
  friendAvatarWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: DD.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: DD.s3,
  },
  friendAvatar: {
    fontSize: 22,
  },
  friendInfo: {
    flex: 1,
  },
  friendName: {
    fontSize: 15,
    fontWeight: '800',
    color: DD.text,
  },
  friendCode: {
    fontSize: 12,
    fontWeight: '600',
    color: DD.textMuted,
    marginTop: 2,
  },
  removeFriendBtn: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusSm,
    backgroundColor: DD.bgElement,
    borderWidth: 1,
    borderColor: DD.border,
  },
  removeFriendBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textMuted,
  },
  sectionHeading: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: DD.textMuted,
    marginBottom: DD.s2,
  },
  requestCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD.bgCard,
    padding: DD.s3,
    borderRadius: DD.radiusLg,
    borderWidth: 1,
    borderColor: DD.border,
    marginBottom: DD.s2,
  },
  requestEmptyCard: {
    padding: DD.s4,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
    alignItems: 'center',
  },
  requestEmptyText: {
    fontSize: 13,
    color: DD.textMuted,
  },
  requestActions: {
    flexDirection: 'row',
    gap: DD.s2,
  },
  acceptBtn: {
    backgroundColor: DD.lime,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusSm,
    minWidth: 60,
    alignItems: 'center',
  },
  acceptBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.bg,
  },
  declineBtn: {
    backgroundColor: DD.bgElement,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusSm,
    borderWidth: 1,
    borderColor: DD.border,
    minWidth: 60,
    alignItems: 'center',
  },
  declineBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textMuted,
  },
  cancelBtn: {
    backgroundColor: DD.bgElement,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusSm,
    borderWidth: 1,
    borderColor: DD.border,
  },
  cancelBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textMuted,
  },
  addCard: {
    backgroundColor: DD.bgCard,
    padding: DD.s5,
    borderRadius: DD.radiusLg,
    borderWidth: 1,
    borderColor: DD.border,
  },
  addTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s1,
  },
  addSub: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
    marginBottom: DD.s4,
  },
  inputRow: {
    flexDirection: 'row',
    gap: DD.s2,
    marginBottom: DD.s3,
  },
  codeInput: {
    flex: 1,
    backgroundColor: DD.bgElement,
    borderWidth: 1,
    borderColor: DD.border,
    borderRadius: DD.radiusMd,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s3,
    color: DD.text,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1,
  },
  lookupBtn: {
    backgroundColor: DD.lime,
    paddingHorizontal: DD.s4,
    borderRadius: DD.radiusMd,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 70,
  },
  lookupBtnText: {
    color: DD.bg,
    fontWeight: '900',
    fontSize: 14,
  },
  errorBox: {
    backgroundColor: '#381616',
    borderColor: '#782828',
    borderWidth: 1,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s3,
  },
  errorText: {
    color: '#FFAAAA',
    fontSize: 12,
    lineHeight: 16,
  },
  successBox: {
    backgroundColor: '#12331E',
    borderColor: '#1D6336',
    borderWidth: 1,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s3,
  },
  successText: {
    color: DD.lime,
    fontSize: 13,
    fontWeight: '700',
  },
  lookupResultCard: {
    backgroundColor: DD.bgElement,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s4,
    borderRadius: DD.radiusMd,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: DD.s2,
  },
  lookupResultLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  lookupResultAvatar: {
    fontSize: 28,
  },
  lookupResultName: {
    fontSize: 15,
    fontWeight: '800',
    color: DD.text,
  },
  lookupResultCode: {
    fontSize: 12,
    fontWeight: '600',
    color: DD.lime,
    marginTop: 2,
  },
  sendReqBtn: {
    backgroundColor: DD.lime,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
  },
  sendReqBtnText: {
    color: DD.bg,
    fontWeight: '800',
    fontSize: 13,
  },
  alreadyFriendsBadge: {
    backgroundColor: DD.bgCard,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.lime + '44',
  },
  alreadyFriendsText: {
    color: DD.lime,
    fontSize: 11,
    fontWeight: '700',
  },
  pendingBadge: {
    backgroundColor: DD.bgCard,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  pendingBadgeText: {
    color: DD.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
});
