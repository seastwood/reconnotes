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
