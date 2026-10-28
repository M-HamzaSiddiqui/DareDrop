import { Redirect } from 'expo-router';

// The old explore screen has been replaced by the Discover tab.
export default function ExploreRedirect() {
  return <Redirect href="/discover" />;
}
