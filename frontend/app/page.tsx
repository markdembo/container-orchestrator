"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ContainerState {
  id: string;
  session_id: string | null;
  ipv6_address: string;
  health: boolean;
  created_at: number;
  last_activity: number;
}

interface PoolConfig {
  minSize: number;
  maxSize: number;
  currentSize: number;
}

interface Status {
  containers: ContainerState[];
  poolConfig: PoolConfig;
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const response = await fetch("http://localhost:8787/status");
      if (!response.ok) throw new Error("Failed to fetch status");
      const data = (await response.json()) as Status;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const allocateContainer = async () => {
    try {
      const response = await fetch("http://localhost:8787/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error("Failed to allocate container");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };

  const deallocateContainer = async (containerId: string) => {
    try {
      const response = await fetch(`http://localhost:8787/deallocate/${containerId}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to deallocate container");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };

  const resetContainers = async () => {
    if (
      !window.confirm(
        "Are you sure you want to reset all containers? This will clear all existing containers and create new ones."
      )
    ) {
      return;
    }

    try {
      const response = await fetch("http://localhost:8787/reset", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to reset containers");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold mb-8">Container Orchestrator Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Pool Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span>Total Containers:</span>
                <span className="font-bold">{status?.containers.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Available Containers:</span>
                <span className="font-bold">
                  {status?.containers.filter((c) => !c.session_id).length}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Min Pool Size:</span>
                <span className="font-bold">{status?.poolConfig.minSize}</span>
              </div>
              <div className="flex justify-between">
                <span>Max Pool Size:</span>
                <span className="font-bold">{status?.poolConfig.maxSize}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <Button onClick={allocateContainer} className="w-full mb-4">
              Allocate New Container
            </Button>
            <Button onClick={resetContainers} variant="destructive" className="w-full mb-4">
              Reset All Containers
            </Button>
            <Button onClick={fetchStatus} variant="outline" className="w-full">
              Refresh Status
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span>Healthy Containers:</span>
                <span className="font-bold">
                  {status?.containers.filter((c) => c.health).length}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Unhealthy Containers:</span>
                <span className="font-bold">
                  {status?.containers.filter((c) => !c.health).length}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Container List</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">ID</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-left p-2">IPv6 Address</th>
                  <th className="text-left p-2">Created</th>
                  <th className="text-left p-2">Last Activity</th>
                  <th className="text-left p-2">Actions</th>
                  <th className="text-left p-2">Session ID</th>
                </tr>
              </thead>
              <tbody>
                {status?.containers.map((container) => (
                  <tr key={container.id} className="border-b">
                    <td className="p-2 font-mono text-sm">{container.id}</td>
                    <td className="p-2">
                      <Badge variant={container.health ? "success" : "destructive"}>
                        {container.health ? "Healthy" : "Unhealthy"}
                      </Badge>
                    </td>
                    <td className="p-2 font-mono text-sm">{container.ipv6_address}</td>
                    <td className="p-2">{new Date(container.created_at).toLocaleString()}</td>
                    <td className="p-2">{new Date(container.last_activity).toLocaleString()}</td>
                    <td className="p-2">
                      {container.session_id && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deallocateContainer(container.id)}
                        >
                          Deallocate
                        </Button>
                      )}
                    </td>
                    <td className="p-2 font-mono text-sm">{container.session_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
