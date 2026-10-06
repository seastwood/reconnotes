#!/usr/bin/env ruby
# Switches on push notifications for the app (notifications straight from your
# ReconNotes server through Apple, like any other app):
#   - the Push Notifications capability (aps-environment) in App.entitlements
#   - the App target signed with that entitlements file
#
# Needs a paid Apple Developer Program membership: Apple doesn't allow push
# notifications for apps signed with a free (Personal Team) account.
#
# Run on the Mac (once):  npm run ios:enable-push -w @reconnotes/web
# Needs the xcodeproj gem: gem install --user-install xcodeproj  (or: sudo gem install xcodeproj)
# Safe to run again. (By hand instead: Xcode › App target › Signing & Capabilities › + Capability › Push Notifications.)
begin
  require 'xcodeproj'
rescue LoadError
  abort "The xcodeproj Ruby gem is missing. Install it with:\n  gem install --user-install xcodeproj\n(or sudo gem install xcodeproj), then run this again."
end

IOS = File.expand_path('../App', __dir__)
project = Xcodeproj::Project.open(File.join(IOS, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' } or abort 'No "App" target in the Xcode project'

# --auto (used by `npm run ios:setup`): only if the signing team can have push.
# Free Apple IDs (Personal Teams) can't; their provisioning profiles expire after
# 7 days, a paid account's after a year – so look at this Mac's profiles for the team.
if ARGV.include?('--auto')
  require 'date'
  require 'shellwords'
  team = ENV['TEAM'] || app.build_configurations.map { |c| c.build_settings['DEVELOPMENT_TEAM'] }.compact.first
  dirs = [File.expand_path('~/Library/Developer/Xcode/UserData/Provisioning Profiles'), File.expand_path('~/Library/MobileDevice/Provisioning Profiles')]
  days = Dir.glob(dirs.map { |d| File.join(d, '*.mobileprovision') }).filter_map do |f|
    xml = `security cms -D -i #{f.shellescape} 2>/dev/null`
    next if xml.empty?
    teams = xml.scan(%r{<key>TeamIdentifier</key>\s*<array>\s*<string>([^<]+)</string>}).flatten
    next unless team && teams.include?(team)
    created = xml[%r{<key>CreationDate</key>\s*<date>([^<]+)</date>}, 1]
    expires = xml[%r{<key>ExpirationDate</key>\s*<date>([^<]+)</date>}, 1]
    next unless created && expires
    (DateTime.parse(expires) - DateTime.parse(created)).to_i
  end
  if team.nil? || days.empty?
    puts "Push notifications: skipped – couldn't tell whether your signing team#{team ? " (#{team})" : ''} can use them yet."
    puts '  Build once from Xcode, then run this again; or if you have a paid Apple developer account: npm run ios:enable-push'
    exit 0
  end
  if days.max <= 10
    puts "Push notifications: skipped – team #{team} is a free (Personal Team) account, which Apple doesn't allow push for."
    system('ruby', File.join(__dir__, 'disable-push.rb'), out: File::NULL)
    exit 0
  end
end
rel = app.build_configurations.map { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] }.compact.first || 'App/App.entitlements'
path = File.join(IOS, rel)
plist = File.exist?(path) ? (Xcodeproj::Plist.read_from_path(path) || {}) : {}
# "development" works for builds from Xcode; Xcode changes it to "production"
# when you archive for TestFlight / the App Store.
plist['aps-environment'] ||= 'development'
Xcodeproj::Plist.write_to_path(plist, path)

unless project.main_group.recursive_children.any? { |f| f.respond_to?(:path) && f.path && File.basename(f.path) == File.basename(rel) }
  group = project.main_group.find_subpath('App', false) || project.main_group
  group.new_reference(File.basename(rel))
end
app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] = rel }
app.build_configurations.each { |c| c.build_settings['DEVELOPMENT_TEAM'] = ENV['TEAM'] } if ENV['TEAM']
# record the capability so Xcode shows it under Signing & Capabilities
attrs = project.root_object.attributes['TargetAttributes'] ||= {}
t = attrs[app.uuid] ||= {}
caps = t['SystemCapabilities'] ||= {}
caps['com.apple.Push'] = { 'enabled' => '1' }
project.save
puts "Push notifications are on for the App target (#{rel})."
puts 'Next: build and run from Xcode, then in the app: Settings › Notifications › Notifications on this iPhone.'
