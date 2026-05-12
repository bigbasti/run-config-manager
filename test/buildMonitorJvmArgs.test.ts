import { buildMonitorJvmArgs } from '../src/services/monitoring/buildMonitorJvmArgs';

describe('buildMonitorJvmArgs', () => {
  test('returns the expected JMX flag list for a given port', () => {
    const args = buildMonitorJvmArgs(39000);
    expect(args).toEqual([
      '-Dcom.sun.management.jmxremote=true',
      '-Dcom.sun.management.jmxremote.port=39000',
      '-Dcom.sun.management.jmxremote.rmi.port=39000',
      '-Dcom.sun.management.jmxremote.local.only=true',
      '-Dcom.sun.management.jmxremote.authenticate=false',
      '-Dcom.sun.management.jmxremote.ssl=false',
      '-Djava.rmi.server.hostname=127.0.0.1',
    ]);
  });

  test('uses the second port for both .port and .rmi.port (avoids RMI ephemeral)', () => {
    const args = buildMonitorJvmArgs(45123);
    const portArg = args.find(a => a.startsWith('-Dcom.sun.management.jmxremote.port='));
    const rmiArg = args.find(a => a.startsWith('-Dcom.sun.management.jmxremote.rmi.port='));
    expect(portArg).toBe('-Dcom.sun.management.jmxremote.port=45123');
    expect(rmiArg).toBe('-Dcom.sun.management.jmxremote.rmi.port=45123');
  });
});
