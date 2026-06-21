import { describe, it, expect } from "vitest";
import { Semaphore, UserSemaphoreMap } from "../concurrency.js";

describe("Semaphore", () => {
  it("acquires up to max permits", async () => {
    const sem = new Semaphore(2);
    expect(sem.available).toBe(2);
    await sem.acquire();
    expect(sem.available).toBe(1);
    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  it("releases permits", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    expect(sem.available).toBe(0);
    sem.release();
    expect(sem.available).toBe(1);
  });

  it("queues when at capacity", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let acquired = false;
    const p = sem.acquire().then(() => { acquired = true; });

    // Should not have acquired yet
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);

    sem.release();
    await p;
    expect(acquired).toBe(true);
  });
});

describe("UserSemaphoreMap", () => {
  it("creates semaphores per user", () => {
    const map = new UserSemaphoreMap();
    const sem1 = map.get("user1");
    const sem2 = map.get("user2");
    expect(sem1).not.toBe(sem2);
  });

  it("returns same semaphore for same user", () => {
    const map = new UserSemaphoreMap();
    const sem1 = map.get("user1");
    const sem2 = map.get("user1");
    expect(sem1).toBe(sem2);
  });
});
