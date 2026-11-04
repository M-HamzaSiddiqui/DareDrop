import { Redirect } from 'expo-router';

// The old explore screen redirects to Home.
export default function ExploreRedirect() {
  return <Redirect href="/" />;
}
