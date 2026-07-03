import { useState, useEffect } from 'react';

export function useNetworkStatus() {
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const checkNetwork = async () => {
      try {
        const response = await fetch('https://www.google.com', { method: 'HEAD', mode: 'no-cors' });
        setIsConnected(true);
      } catch {
        setIsConnected(false);
      }
    };

    checkNetwork();
    const interval = setInterval(checkNetwork, 15000);
    return () => clearInterval(interval);
  }, []);

  return { isConnected };
}
