import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { DD } from '@/constants/dd-theme';
import { useChallenges } from '@/store/challenges-store';

export default function AppTabs() {
  const { unreadNotificationsCount } = useChallenges();

  return (
    <NativeTabs
      backgroundColor={DD.bgCard}
      indicatorColor={DD.bgElement}
      labelStyle={{
        selected: { color: DD.lime },
        default: { color: DD.textSub },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="discover">
        <NativeTabs.Trigger.Label>Discover</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="create">
        <NativeTabs.Trigger.Label>Create</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/create.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/profile.png')}
          renderingMode="template"
        />
        {unreadNotificationsCount > 0 ? (
          <NativeTabs.Trigger.Badge>
            {unreadNotificationsCount > 99 ? '99+' : String(unreadNotificationsCount)}
          </NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
