"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ContainerState {
  id: string;
  projectId: string | null;
  createdAt: number;
  lastActivity: number;
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

interface Event {
  type: string;
  containerId: string;
  timestamp: number;
  details: string;
  allocationTime?: number; // Time in milliseconds
}

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);

  const connectWebSocket = useCallback(() => {
    const ws = new WebSocket("ws://localhost:8787/ws");

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe" }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "status") {
          setStatus(data.data);
        } else {
          // Handle event and update status
          setStatus(data.status);
          setEvents((prev) => [data.event, ...prev]);

          // Show toast notification
          toast(data.event.type.replace(/_/g, " ").toUpperCase(), {
            description: `Container: ${data.event.containerId}\n${data.event.details}`,
            duration: 5000,
          });

          // If this is a container allocation event, open the container in a new tab
          if (data.event.type === "container_allocated") {
            const container = data.status.containers.find(
              (c: ContainerState) => c.id === data.event.containerId
            );
            if (container) {
              // window.open(``, "_blank");
            }
          }
        }
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      // Attempt to reconnect after 5 seconds
      setTimeout(connectWebSocket, 5000);
    };

    return ws;
  }, []);

  const allocateContainer = async () => {
    const startTime = Date.now();
    try {
      const response = await fetch("http://localhost:8787/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: crypto.randomUUID() }),
      });
      if (!response.ok) throw new Error("Failed to allocate container");
      const data = (await response.json()) as ContainerState;
      const endTime = Date.now();
      const allocationTime = endTime - startTime;

      // Add allocation time to events
      setEvents((prev) => [
        {
          type: "container_allocated",
          containerId: data.id,
          timestamp: endTime,
          details: `Container allocated successfully`,
          allocationTime: allocationTime,
        },
        ...prev,
      ]);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };

  useEffect(() => {
    const ws = connectWebSocket();
    return () => {
      ws.close();
    };
  }, [connectWebSocket]);

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

      <Tabs defaultValue="containers" className="mb-8">
        <TabsList>
          <TabsTrigger value="containers">Containers</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="containers">
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
                      {status?.containers.filter((c) => !c.projectId).length}
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
                <Button onClick={resetContainers} variant="destructive" className="w-full">
                  Reset All Containers
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
                    <span>Current Size:</span>
                    <span className="font-bold">{status?.poolConfig.currentSize}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Allocated Containers:</span>
                    <span className="font-bold">
                      {status?.containers.filter((c) => c.projectId).length}
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
                      <th className="text-left p-2">Created</th>
                      <th className="text-left p-2">Last Activity</th>
                      <th className="text-left p-2">Actions</th>
                      <th className="text-left p-2">Project ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status?.containers.map((container) => (
                      <tr key={container.id} className="border-b">
                        <td className="p-2 font-mono text-sm">{container.id}</td>
                        <td className="p-2">
                          <Badge variant={container.projectId ? "outline" : "success"}>
                            {container.projectId ? "Allocated" : "Available"}
                          </Badge>
                        </td>
                        <td className="p-2">{new Date(container.createdAt).toLocaleString()}</td>
                        <td className="p-2">{new Date(container.lastActivity).toLocaleString()}</td>
                        <td className="p-2">
                          {container.projectId && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => deallocateContainer(container.id)}
                            >
                              Deallocate
                            </Button>
                          )}
                        </td>
                        <td className="p-2 font-mono text-sm">{container.projectId || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="events">
          <Card>
            <CardHeader>
              <CardTitle>Event Log</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left p-2">Type</th>
                      <th className="text-left p-2">Container ID</th>
                      <th className="text-left p-2">Timestamp</th>
                      <th className="text-left p-2">Details</th>
                      <th className="text-left p-2">Allocation Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event, index) => (
                      <tr key={index} className="border-b">
                        <td className="p-2">
                          <Badge variant="outline">
                            {event.type.replace(/_/g, " ").toUpperCase()}
                          </Badge>
                        </td>
                        <td className="p-2 font-mono text-sm">{event.containerId}</td>
                        <td className="p-2">{new Date(event.timestamp).toLocaleString()}</td>
                        <td className="p-2 font-mono text-sm">{event.details}</td>
                        <td className="p-2">
                          {event.allocationTime ? `${event.allocationTime}ms` : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
