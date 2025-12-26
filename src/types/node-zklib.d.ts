declare module 'node-zklib' {
  interface ZKLibOptions {
    ip: string;
    port: number;
    timeout?: number;
    inport?: number;
  }

  interface AttendanceLog {
    uid: number;
    id: number;
    state: number;
    timestamp: number;
    type: number;
  }

  interface DeviceUser {
    uid: number;
    name: string;
    privilege: number;
    password: string;
    groupId: string;
    userId: string;
    card: number;
  }

  class ZKLib {
    static createSocket(options: ZKLibOptions): Promise<ZKLib>;
    disconnect(): Promise<void>;
    getAttendances(): Promise<AttendanceLog[]>;
    getUsers(): Promise<DeviceUser[]>;
    getSerialNumber(): Promise<string | null>;
    getTime(): Promise<Date | null>;
    setTime(date: Date): Promise<void>;
    clearAttendanceLog(): Promise<void>;
  }

  export = ZKLib;
}

